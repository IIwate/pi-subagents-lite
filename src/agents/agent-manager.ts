/**
 * agent-manager.ts — Tracks agents, per-model concurrency, background execution.
 *
 * Supports per-model and per-provider concurrency limits with queuing.
 */

import { randomUUID } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { continueAgentSession, runAgent } from "./agent-runner.js";
import {
  type AgentRecord,
  type AgentStatus,
  type RunCallbacks,
  type StopInitiator,
  type SpawnConfig,
} from "../types.js";
import type { SubagentType } from "./types.js";
import { addUsage, getSessionContextPercent } from "./usage.js";
import { errorMessage } from "../utils.js";
import { needsUserInput } from "./failure-state.js";
import {
  DEBUG_RECOVERY_TTL_MS,
  type ArmedDebugFault,
  type DebugFaultKind,
} from "./debug-fault.js";

/** How often to check for expired agent records (milliseconds). */
const CLEANUP_INTERVAL_MS = 60_000;

/** Age after which a completed agent record is evicted (milliseconds). */
const CLEANUP_AGE_CUTOFF_MS = 10 * 60_000;

/** Recovery window for ordinary failed live sessions still available for user input. */
const NORMAL_RECOVERY_TTL_MS = 30 * 60_000;

/** Maximum wait for child shutdown handlers; disposal continues after this timeout (milliseconds). */
const SESSION_SHUTDOWN_TIMEOUT_MS = 15_000;

/** UUID prefix length for agent IDs stored in the agents map (uniqueness). */
const AGENT_ID_PREFIX_LENGTH = 17;



/** Default per-model concurrency limit when not specified in config. */
const DEFAULT_CONCURRENCY_LIMIT = 4;

/** Whether the agent status is terminal (no longer running or queued). */
function isTerminalStatus(status: AgentStatus): boolean {
  return status !== "running" && status !== "queued";
}

/** Configuration for per-model concurrency limits. */
export interface ConcurrencyConfig {
  /** Default concurrency limit for models not in the models or providers map. */
  default: number;
  /** Per-provider concurrency limits keyed by provider name (e.g. "llamacpp"). */
  providers?: Record<string, number>;
  /** Per-model concurrency limits keyed by "provider/modelId". */
  models?: Record<string, number>;
}

export interface DebugAgentDiagnostic {
  id: string;
  type: string;
  status: AgentStatus;
  session: "live" | "none";
  settled: boolean;
  resultConsumed: boolean;
  recoverable: boolean;
  debugFaultKind?: DebugFaultKind;
  recoveryPaused: boolean;
  recoveryRemainingMs?: number;
  error?: string;
}

export interface DebugDiagnostics {
  armedFault?: ArmedDebugFault;
  agents: DebugAgentDiagnostic[];
}

type OnAgentComplete = (record: AgentRecord) => void;
type OnAgentRemove = (record: AgentRecord) => void;

/** Internal per-model concurrency state. */
interface ConcurrencySlot {
  limit: number;
  running: number;
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

export interface SpawnOptions extends SpawnConfig {
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onRemove?: OnAgentRemove;

  /** Per-model concurrency slots keyed by "provider/modelId". */
  private concurrencySlots = new Map<string, ConcurrencySlot>();

  /** Per-provider concurrency slots — shared pool for all models from a provider. */
  private providerSlots = new Map<string, ConcurrencySlot>();

  /** Default concurrency limit for models not in the slots map. */
  private defaultConcurrency: number;

  /** Queue of agents waiting to start, keyed by modelKey. */
  private queue: { id: string; modelKey: string; args: SpawnArgs }[] = [];
  /** Resolvers for foreground callers waiting on queued records to start and settle. */
  private queuedResolvers = new Map<string, (result: string) => void>();

  /** In-flight child session teardowns, awaited by dispose() so cleanup is not cut short. */
  private closing = new Set<Promise<void>>();

  /** One-shot fault used by the session-local Debug menu. */
  private armedDebugFault?: ArmedDebugFault;
  /** Exact expiry timers for recoverable failures. */
  private recoveryExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** In-flight dispose call, preventing reentrant shutdown chains from mutating closing concurrently. */
  private disposing = false;

  constructor(
    onComplete?: OnAgentComplete,
    concurrency?: ConcurrencyConfig,
  ) {
    this.onComplete = onComplete;
    this.defaultConcurrency = concurrency?.default ?? DEFAULT_CONCURRENCY_LIMIT;

    // Initialize per-provider slots from config (shared pool)
    for (const [provider, limit] of Object.entries(concurrency?.providers ?? {})) {
      this.applyConcurrencyEntry(this.providerSlots, provider, limit);
    }

    // Initialize per-model slots from config
    for (const [modelKey, limit] of Object.entries(concurrency?.models ?? {})) {
      this.applyConcurrencyEntry(this.concurrencySlots, modelKey, limit);
    }

    this.cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupInterval.unref();
  }

  /**
   * Update the concurrency configuration.
   * Existing slots are updated; new slots are created; removed slots stay
   * (their running count will drain naturally). The queue is drained after
   * update so newly expanded limits take effect immediately.
   */
  setConcurrency(config: ConcurrencyConfig): void {
    this.defaultConcurrency = config.default;

    // Update per-provider slots (shared pool)
    for (const [provider, limit] of Object.entries(config.providers ?? {})) {
      this.applyConcurrencyEntry(this.providerSlots, provider, limit);
    }

    // Update existing slots and create new ones
    for (const [modelKey, limit] of Object.entries(config.models ?? {})) {
      this.applyConcurrencyEntry(this.concurrencySlots, modelKey, limit);
    }

    // Start queued agents if the new limits allow
    this.drainQueue();
  }

  /** Arm a one-shot Debug failure for the next agent that actually starts. */
  armDebugFault(kind: DebugFaultKind): void {
    this.armedDebugFault = { kind };
  }

  clearDebugFault(): void {
    this.armedDebugFault = undefined;
  }

  /** Freeze a recoverable record's countdown while its child view is active. */
  pauseRecoveryExpiry(id: string): boolean {
    const record = this.agents.get(id);
    if (!record || !needsUserInput(record)) return false;
    const expiresAt = this.recoveryExpiresAt(record);
    record.execution.recoveryExpiryPausedRemainingMs = Math.max(0, expiresAt - Date.now());
    record.execution.recoveryExpiresAt = undefined;
    this.clearRecoveryExpiry(id);
    return true;
  }

  /** Resume a paused countdown without granting a fresh recovery window. */
  resumeRecoveryExpiry(id: string): boolean {
    const record = this.agents.get(id);
    const remaining = record?.execution.recoveryExpiryPausedRemainingMs;
    if (!record || remaining == null || !needsUserInput(record)) return false;
    record.execution.recoveryExpiryPausedRemainingMs = undefined;
    record.execution.recoveryExpiresAt = Date.now() + remaining;
    this.scheduleRecoveryExpiry(record);
    return true;
  }

  debugDiagnostics(): DebugDiagnostics {
    const now = Date.now();
    return {
      armedFault: this.armedDebugFault,
      agents: this.listAgents().map((record) => {
        const recoverable = needsUserInput(record);
        return {
          id: record.id,
          type: record.display.type,
          status: record.lifecycle.status,
          session: record.execution.session ? "live" : "none",
          settled: record.execution.settled === true,
          resultConsumed: record.lifecycle.resultConsumed === true,
          recoverable,
          debugFaultKind: record.execution.debugFaultKind,
          recoveryPaused: recoverable
            && record.execution.recoveryExpiryPausedRemainingMs != null,
          recoveryRemainingMs: recoverable
            ? this.recoveryRemainingMs(record, now)
            : undefined,
          error: record.error,
        };
      }),
    };
  }

  /**
   * Update or create a concurrency slot entry.
   * If the key already exists in the map, updates its limit.
   * Otherwise, creates a new slot with the given limit and running=0.
   */
  private applyConcurrencyEntry(map: Map<string, ConcurrencySlot>, key: string, limit: number): void {
    const safeLimit = Math.max(1, limit);
    const existing = map.get(key);
    if (existing) {
      existing.limit = safeLimit;
    } else {
      map.set(key, { limit: safeLimit, running: 0 });
    }
  }

  /**
   * Get or create a concurrency slot for a model key.
   * Precedence: per-model slot > per-provider shared slot > default (per-model).
   */
  private getSlot(modelKey: string): ConcurrencySlot {
    // 1. Check per-model slot
    let slot = this.concurrencySlots.get(modelKey);
    if (slot) return slot;

    // 2. Check per-provider shared slot
    const provider = modelKey.split("/")[0];
    const providerSlot = this.providerSlots.get(provider);
    if (providerSlot) return providerSlot;

    // 3. Create per-model slot with default limit
    slot = { limit: Math.max(1, this.defaultConcurrency), running: 0 };
    this.concurrencySlots.set(modelKey, slot);
    return slot;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the per-model concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    const id = randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH);
    const abortController = new AbortController();
    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    // Check concurrency — applies to both foreground and background agents
    let queued = false;
    let concurrencySlot: ConcurrencySlot | undefined;
    if (options.modelKey) {
      const slot = this.getSlot(options.modelKey);
      if (slot.running >= slot.limit) {
        queued = true;
      } else {
        concurrencySlot = slot;
      }
    }

    let queuedPromise: Promise<string> | undefined;
    if (queued) {
      queuedPromise = new Promise(resolve => this.queuedResolvers.set(id, resolve));
      this.queue.push({ id, modelKey: options.modelKey!, args });
    }

    const record: AgentRecord = {
      id,
      lifecycle: {
        status: queued ? "queued" : "running",
        startedAt: Date.now(),
      },
      display: {
        type,
        description: options.description,
        invocation: options.invocation,
      },
      execution: {
        abortController,
        promise: queuedPromise,
        settled: false,
        modelKey: options.modelKey,
        graceTurns: options.graceTurns,
      },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        toolUses: 0,
        turnCount: 1,
        compactionCount: 0,
        maxTurns: options.maxTurns,
      },
    };
    this.agents.set(id, record);

    if (queued) return id;

    // startAgent can throw — clean up record so callers don't see an orphan
    try {
      this.startAgent(id, record, args, concurrencySlot);
    } catch (err) {
      this.agents.delete(id);
      throw err;
    }
    return id;
  }

  /**
   * Actually start an agent (called immediately or from queue drain).
   * When concurrencySlot is provided, the slot's running count is managed
   * (incremented on start, decremented in finally).
   */
  private startAgent(
    id: string,
    record: AgentRecord,
    { pi, ctx, type, prompt, options }: SpawnArgs,
    concurrencySlot?: ConcurrencySlot,
  ) {
    if (concurrencySlot) concurrencySlot.running++;

    const debugFault = this.armedDebugFault;
    this.armedDebugFault = undefined;
    record.lifecycle.status = "running";
    record.lifecycle.startedAt = Date.now();
    record.execution.settled = false;

    // Wire parent abort signal to stop the subagent when the parent is interrupted
    if (options.signal) {
      options.signal.addEventListener("abort", () => this.abort(id, "agent"), { once: true });
    }

    const promise = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      modelSource: options.modelSource,
      maxTurns: options.maxTurns,
      thinkingLevel: options.thinkingLevel,
      cwd: options.worktreePath,
      graceTurns: options.graceTurns,
      signal: record.execution.abortController!.signal,
      debugFault: debugFault?.kind,
      ...this.createRecordCallbacks(record),
      onTurnEnd: (turnCount) => {
        record.stats.turnCount = turnCount;
      },
      onSessionCreated: (session) => {
        record.execution.session = session;
        if (debugFault) {
          record.execution.debugFaultKind = debugFault.kind;
          record.execution.recoveryTtlMs = DEBUG_RECOVERY_TTL_MS;
        }
        // Replace queued predictions with the session's actual model/thinking.
        const inv = record.display.invocation ?? {};
        if (session.model?.id) inv.modelName = session.model.id;
        if (session.model?.provider) inv.providerName = session.model.provider;
        if (session.thinkingLevel) inv.thinkingLevel = session.thinkingLevel;
        record.display.invocation = inv;
        // Flush any steers that arrived before the session was ready
        if (record.execution.pendingSteers?.length) {
          for (const pending of record.execution.pendingSteers) {
            session.steer(pending.message, pending.images).catch(() => {
              // Steer is advisory — a failure here (e.g. session already aborting)
              // is fine; the user can re-send if needed.
            });
          }
          record.execution.pendingSteers = undefined;
        }
      },
    })
      .then(({ responseText, session, aborted, turnLimited }) => {
        record.execution.session = session;
        // Don't overwrite status if externally stopped via abort()
        if (record.lifecycle.status !== "stopped") {
          record.lifecycle.status = aborted ? "aborted" : turnLimited ? "turn_limited" : "completed";
        }
        record.result = responseText;
        record.stats.contextPercent = getSessionContextPercent(session);
        record.lifecycle.completedAt ??= Date.now();
        return responseText;
      })
      .catch((err) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.lifecycle.status !== "stopped") {
          record.lifecycle.status = "error";
        }
        record.result = undefined;
        record.error = errorMessage(err);
        record.lifecycle.completedAt ??= Date.now();
        return "";
      })
      .finally(() => {
        // Decrement per-model concurrency count
        if (concurrencySlot) concurrencySlot.running--;

        record.execution.settled = true;
        this.scheduleRecoveryExpiry(record);
        this.safeNotifyComplete(record);
        this.drainQueue();
      });

    const resolveQueued = this.queuedResolvers.get(id);
    if (resolveQueued) {
      this.queuedResolvers.delete(id);
      promise.then(resolveQueued, () => resolveQueued(""));
    } else {
      record.execution.promise = promise;
    }
  }

  /** Resolve a foreground wait that was cancelled or failed before start. */
  private settleQueued(id: string): void {
    const resolve = this.queuedResolvers.get(id);
    if (!resolve) return;
    this.queuedResolvers.delete(id);
    resolve("");
  }

  /** Notify completion callback, ignoring any errors. */
  private safeNotifyComplete(record: AgentRecord): void {
    try { this.onComplete?.(record); } catch { /* ignore */ }
  }

  setOnComplete(cb: OnAgentComplete): void {
    this.onComplete = cb;
  }

  setOnRemove(cb: OnAgentRemove): void {
    this.onRemove = cb;
  }

  /** Build runner callbacks that update the record's tool, usage, and compaction stats. */
  private createRecordCallbacks(record: AgentRecord): Required<Pick<RunCallbacks, "onToolUse" | "onAssistantUsage" | "onCompaction">> {
    return {
      onToolUse: () => {
        record.stats.toolUses++;
      },
      onAssistantUsage: (usage) => {
        addUsage(record.stats.lifetimeUsage, usage);
      },
      onCompaction: () => {
        record.stats.compactionCount++;
      },
    };
  }

  /** Start queued agents up to the per-model concurrency limits. */
  private drainQueue() {
    const started = new Set<string>();
    for (const entry of this.queue) {
      const record = this.agents.get(entry.id);
      if (!record || record.lifecycle.status !== "queued") continue;

      if (entry.args.options.modelSource === "automatic" && entry.args.options.resolveModelAtStart) {
        try {
          const resolved = entry.args.options.resolveModelAtStart();
          entry.modelKey = resolved.modelKey;
          entry.args.options.model = resolved.model;
          entry.args.options.modelKey = resolved.modelKey;
          if (entry.args.options.thinkingSource !== "explicit") {
            entry.args.options.thinkingLevel = resolved.thinkingLevel;
          }
          record.execution.modelKey = resolved.modelKey;
        } catch (err) {
          record.lifecycle.status = "error";
          record.error = errorMessage(err);
          record.lifecycle.completedAt = Date.now();
          record.execution.settled = true;
          started.add(entry.id);
          this.settleQueued(entry.id);
          this.safeNotifyComplete(record);
          continue;
        }
      }

      const slot = this.getSlot(entry.modelKey);
      if (slot.running >= slot.limit) continue;

      try {
        this.startAgent(entry.id, record, entry.args, slot);
        started.add(entry.id);
      } catch (err) {
        // Late failure — surface on the record so the user can see it
        record.lifecycle.status = "error";
        record.error = errorMessage(err);
        record.lifecycle.completedAt = Date.now();
        record.execution.settled = true;
        started.add(entry.id);
        this.settleQueued(entry.id);
        this.safeNotifyComplete(record);
      }
    }
    this.queue = this.queue.filter(e => !started.has(e.id));
  }


  /**
   * Send a steering message to a running agent.
   * If the session hasn't been created yet, the message is queued.
   */
  private async steer(id: string, message: string, images?: ImageContent[]): Promise<boolean> {
    const record = this.agents.get(id);
    if (!record) return false;

    if (record.lifecycle.status !== "running") return false;

    if (!record.execution.session) {
      // Session not yet created — queue the steer
      if (!record.execution.pendingSteers) record.execution.pendingSteers = [];
      record.execution.pendingSteers.push({ message, images });
      return true;
    }

    try {
      await record.execution.session.steer(message, images);
      return true;
    } catch {
      // steer failures are surfaced to the caller via the boolean return value
      return false;
    }
  }

  /**
   * Send a user message to an agent. Running agents receive a steering message;
   * settled agents resume their existing session with a new prompt.
   */
  async interact(
    id: string,
    message: string,
    images?: ImageContent[],
  ): Promise<boolean> {
    const record = this.agents.get(id);
    if (!record || record.lifecycle.status === "queued") return false;

    if (record.lifecycle.status === "running") {
      return this.steer(id, message, images);
    }

    const session = record.execution.session;
    if (!session || !record.execution.settled || session.isStreaming) return false;

    let concurrencySlot: ConcurrencySlot | undefined;
    if (record.execution.modelKey) {
      const slot = this.getSlot(record.execution.modelKey);
      if (slot.running >= slot.limit) return false;
      slot.running++;
      concurrencySlot = slot;
    }

    // Do not alter a fault-bound recovery deadline until this continuation is
    // guaranteed to start. A full model slot must leave the exact expiry timer intact.
    this.clearRecoveryExpiry(id);
    record.execution.recoveryTtlMs = undefined;
    record.execution.recoveryExpiresAt = undefined;
    record.execution.recoveryExpiryPausedRemainingMs = undefined;

    const previousTurns = record.stats.turnCount ?? 0;
    const abortController = new AbortController();
    // abort() returns a promise and this runs from an event listener, so an
    // unhandled rejection would escape the run. The session is by definition
    // being torn down here, which is exactly when abort() can reject.
    const abortSession = () => { void session.abort().catch(() => {}); };
    abortController.signal.addEventListener("abort", abortSession, { once: true });

    record.execution.abortController = abortController;
    record.execution.settled = false;
    record.lifecycle.status = "running";
    record.lifecycle.startedAt = Date.now();
    record.lifecycle.completedAt = undefined;
    record.lifecycle.resultConsumed = undefined;
    record.result = undefined;
    record.error = undefined;

    const trackedCallbacks = this.createRecordCallbacks(record);
    const promise = continueAgentSession(session, message, {
      ...trackedCallbacks,
      images,
      maxTurns: record.stats.maxTurns,
      graceTurns: record.execution.graceTurns,
      onTurnEnd: (turnCount) => {
        record.stats.turnCount = previousTurns + turnCount;
      },
    })
      .then(({ responseText, aborted, turnLimited }) => {
        if (record.lifecycle.status !== "stopped") {
          record.lifecycle.status = aborted
            ? "aborted"
            : turnLimited
              ? "turn_limited"
              : "completed";
        }
        record.result = responseText;
        record.stats.contextPercent = getSessionContextPercent(session);
        record.lifecycle.completedAt ??= Date.now();
        record.lifecycle.resultConsumed = true;
        return responseText;
      })
      .catch((err) => {
        if (record.lifecycle.status !== "stopped") {
          record.lifecycle.status = "error";
        }
        record.result = undefined;
        record.error = errorMessage(err);
        record.lifecycle.completedAt ??= Date.now();
        record.lifecycle.resultConsumed = true;
        return "";
      })
      .finally(() => {
        abortController.signal.removeEventListener("abort", abortSession);
        if (concurrencySlot) concurrencySlot.running--;
        record.execution.settled = true;
        this.scheduleRecoveryExpiry(record);
        this.safeNotifyComplete(record);
        this.drainQueue();
      });

    record.execution.promise = promise;
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.lifecycle.startedAt - a.lifecycle.startedAt,
    );
  }

  abort(id: string, stoppedBy?: StopInitiator): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    return this.stopAgent(record, stoppedBy);
  }

  /**
   * Manually clear an agent from the TUI list.
   * Running/queued agents are stopped first, then the record is removed immediately.
   */
  clear(id: string, stoppedBy: StopInitiator = "user"): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    if (!isTerminalStatus(record.lifecycle.status)) {
      this.stopAgent(record, stoppedBy);
    }
    this.removeRecord(id, record);
    return true;
  }

  /**
   * Stop an agent by aborting its session or removing it from the queue.
   * Returns true if the agent was stopped, false if it wasn't running/queued.
   */
  private stopAgent(record: AgentRecord, stoppedBy?: StopInitiator): boolean {
    const wasQueued = record.lifecycle.status === "queued";
    if (wasQueued) {
      this.queue = this.queue.filter(q => q.id !== record.id);
    } else if (record.lifecycle.status !== "running") {
      return false;
    } else {
      record.execution.abortController?.abort();
    }
    record.lifecycle.status = "stopped";
    record.lifecycle.stoppedBy = stoppedBy;
    record.lifecycle.completedAt = Date.now();
    if (wasQueued) {
      record.execution.settled = true;
      this.settleQueued(record.id);
      this.safeNotifyComplete(record);
    }
    return true;
  }

  private recoveryWindowMs(record: AgentRecord): number {
    return record.execution.recoveryTtlMs ?? NORMAL_RECOVERY_TTL_MS;
  }

  private recoveryExpiresAt(record: AgentRecord): number {
    return record.execution.recoveryExpiresAt
      ?? (record.lifecycle.completedAt ?? Date.now()) + this.recoveryWindowMs(record);
  }

  private recoveryRemainingMs(record: AgentRecord, now = Date.now()): number {
    return record.execution.recoveryExpiryPausedRemainingMs
      ?? Math.max(0, this.recoveryExpiresAt(record) - now);
  }

  private clearRecoveryExpiry(id: string): void {
    const timer = this.recoveryExpiryTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.recoveryExpiryTimers.delete(id);
  }

  /** Schedule exact expiry so Debug's 10-second scenario is not delayed by cleanup polling. */
  private scheduleRecoveryExpiry(record: AgentRecord): void {
    this.clearRecoveryExpiry(record.id);
    if (!needsUserInput(record) || record.execution.recoveryExpiryPausedRemainingMs != null) return;

    const expiresAt = this.recoveryExpiresAt(record);
    record.execution.recoveryExpiresAt = expiresAt;
    const timer = setTimeout(() => {
      this.recoveryExpiryTimers.delete(record.id);
      if (this.agents.get(record.id) !== record || !needsUserInput(record)) return;
      if (record.execution.recoveryExpiryPausedRemainingMs != null) return;
      if (Date.now() < expiresAt) {
        this.scheduleRecoveryExpiry(record);
        return;
      }
      this.removeRecord(record.id, record);
    }, Math.max(0, expiresAt - Date.now()));
    timer.unref?.();
    this.recoveryExpiryTimers.set(record.id, timer);
  }

  /**
   * Emit session_shutdown to a child session's extensions, then dispose it.
   *
   * AgentSession.dispose() does not emit session_shutdown, so extensions holding
   * session-scoped resources (processes, sockets, watchers) never release them
   * when a subagent is cleared, evicted, or killed with the parent. Subagents run
   * their own extension instances, so the parent's shutdown does not cover them.
   *
   * emit() awaits handlers serially without a timeout. A hung child extension handler would
   * permanently block parent shutdown (events.ts session_shutdown -> dispose() -> host
   * process.exit). Bound only the emit phase, then still call session.dispose() to release
   * local resources.
   *
   * This relies on the isInsideSubagentSpawn() early return in index.ts: extension instances
   * inside child sessions do not register session_shutdown, so this emit cannot recurse into dispose().
   */
  private closeSession(session: AgentSession): Promise<void> {
    const done = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, SESSION_SHUTDOWN_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        session.dispose();
      }
    })().catch(() => { /* teardown is best effort — never block agent removal */ });
    this.closing.add(done);
    void done.finally(() => this.closing.delete(done));
    return done;
  }

  /** Shut down and dispose a record's session, then remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    this.clearRecoveryExpiry(id);
    const session = record.execution.session;
    record.execution.session = undefined;
    this.agents.delete(id);
    if (session) void this.closeSession(session);
    try { this.onRemove?.(record); } catch { /* ignore */ }
  }

  private cleanup() {
    const now = Date.now();
    for (const [id, record] of this.agents) {
      if (!isTerminalStatus(record.lifecycle.status)) continue;
      const waitingForInput = needsUserInput(record);
      // Ordinary terminal results stay until the LLM has read them. A failed live
      // session has a finite recovery deadline instead, even if its nudge failed.
      if (!waitingForInput && !record.lifecycle.resultConsumed) continue;
      if (waitingForInput) {
        // An active child view intentionally freezes its remaining recovery time.
        if (record.execution.recoveryExpiryPausedRemainingMs != null) continue;
        if (this.recoveryExpiresAt(record) >= now) continue;
      } else if ((record.lifecycle.completedAt ?? 0) >= now - CLEANUP_AGE_CUTOFF_MS) {
        continue;
      }
      this.removeRecord(id, record);
    }
  }

  async dispose() {
    if (this.disposing) return;
    this.disposing = true;
    clearInterval(this.cleanupInterval);
    for (const id of [...this.recoveryExpiryTimers.keys()]) this.clearRecoveryExpiry(id);
    for (const record of this.agents.values()) {
      if (record.lifecycle.status !== "queued") continue;
      record.lifecycle.status = "error";
      record.error = "Agent manager disposed before the queued agent could start.";
      record.lifecycle.completedAt = Date.now();
      record.execution.settled = true;
    }
    for (const id of this.queuedResolvers.keys()) this.settleQueued(id);
    this.queue = [];
    for (const record of this.agents.values()) {
      const session = record.execution.session;
      record.execution.session = undefined;
      if (session) void this.closeSession(session);
    }
    this.agents.clear();
    await Promise.all(this.closing);
  }
}
