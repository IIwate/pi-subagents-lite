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
  /** Per-model ceiling used when no explicit model override exists. */
  default: number;
  /** Shared hard ceilings keyed by provider name (e.g. "llamacpp"). */
  providers?: Record<string, number>;
  /** Per-model hard ceilings keyed by "provider/modelId". */
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

export type InteractionResult =
  | { accepted: true }
  | {
      accepted: false;
      reason: "concurrency" | "queued" | "unavailable";
      modelKey?: string;
    };

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

  /** Explicit per-model ceilings keyed by "provider/modelId". */
  private modelLimits = new Map<string, number>();

  /** Shared hard ceilings keyed by provider. */
  private providerLimits = new Map<string, number>();

  /** Running counts are independent from mutable limits so config changes preserve live accounting. */
  private modelRunning = new Map<string, number>();
  private providerRunning = new Map<string, number>();

  /** Per-model ceiling when no explicit model override exists. */
  private defaultConcurrency: number;

  /** Queue of agents waiting to start, keyed by modelKey. */
  private queue: { id: string; modelKey: string; args: SpawnArgs }[] = [];
  /** Resolvers for foreground callers waiting on queued records to start and settle. */
  private queuedResolvers = new Map<string, (result: string) => void>();
  /** Parent interrupt listeners scoped to the initial foreground execution only. */
  private parentAbortCleanups = new Map<string, () => void>();

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
    this.defaultConcurrency = DEFAULT_CONCURRENCY_LIMIT;
    this.setConcurrency(concurrency ?? { default: DEFAULT_CONCURRENCY_LIMIT });

    this.cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupInterval.unref();
  }

  /** Replace mutable ceilings while preserving live running counts. */
  setConcurrency(config: ConcurrencyConfig): void {
    this.defaultConcurrency = Math.max(1, config.default);
    this.providerLimits = new Map(
      Object.entries(config.providers ?? {}).map(([key, limit]) => [key, Math.max(1, limit)]),
    );
    this.modelLimits = new Map(
      Object.entries(config.models ?? {}).map(([key, limit]) => [key, Math.max(1, limit)]),
    );
    this.drainQueue();
  }

  /** Arm a one-shot Debug failure for the next agent that actually starts. */
  armDebugFault(kind: DebugFaultKind): void {
    this.armedDebugFault = { kind };
  }

  clearDebugFault(): void {
    this.armedDebugFault = undefined;
  }

  /** Track the active child view as an independent recovery-expiry pause reason. */
  pauseRecoveryExpiry(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    this.setRecoveryExpiryPause(record, "view", true);
    return true;
  }

  /** Release only the active-view pause without granting a fresh recovery window. */
  resumeRecoveryExpiry(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    this.setRecoveryExpiryPause(record, "view", false);
    return true;
  }

  /** Toggle a session-local pin. Pins pause automatic cleanup but never block manual clear. */
  togglePinned(id: string): boolean | undefined {
    const record = this.agents.get(id);
    if (!record) return undefined;

    const pinnedAt = record.lifecycle.pinnedAt;
    if (pinnedAt == null) {
      record.lifecycle.pinnedAt = Date.now();
      this.setRecoveryExpiryPause(record, "pin", true);
      return true;
    }

    const now = Date.now();
    if (
      isTerminalStatus(record.lifecycle.status)
      && !needsUserInput(record)
      && record.lifecycle.completedAt != null
    ) {
      const pausedFrom = Math.max(pinnedAt, record.lifecycle.completedAt);
      record.lifecycle.cleanupExpiryPausedMs = (record.lifecycle.cleanupExpiryPausedMs ?? 0)
        + Math.max(0, now - pausedFrom);
    }
    record.lifecycle.pinnedAt = undefined;
    this.setRecoveryExpiryPause(record, "pin", false);
    return false;
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

  private providerFromModelKey(modelKey: string): string {
    const slash = modelKey.indexOf("/");
    return slash > 0 ? modelKey.slice(0, slash) : modelKey;
  }

  private runningCount(counts: ReadonlyMap<string, number>, key: string): number {
    return counts.get(key) ?? 0;
  }

  /** Provider and model ceilings are independent; every run must satisfy both. */
  private hasConcurrencyCapacity(modelKey: string): boolean {
    const modelLimit = this.modelLimits.get(modelKey) ?? this.defaultConcurrency;
    if (this.runningCount(this.modelRunning, modelKey) >= modelLimit) return false;

    const provider = this.providerFromModelKey(modelKey);
    const providerLimit = this.providerLimits.get(provider);
    return providerLimit == null
      || this.runningCount(this.providerRunning, provider) < providerLimit;
  }

  private reserveConcurrency(modelKey: string): boolean {
    if (!this.hasConcurrencyCapacity(modelKey)) return false;
    const provider = this.providerFromModelKey(modelKey);
    this.modelRunning.set(modelKey, this.runningCount(this.modelRunning, modelKey) + 1);
    this.providerRunning.set(provider, this.runningCount(this.providerRunning, provider) + 1);
    return true;
  }

  private releaseConcurrency(modelKey: string): void {
    const provider = this.providerFromModelKey(modelKey);
    const modelRunning = Math.max(0, this.runningCount(this.modelRunning, modelKey) - 1);
    const providerRunning = Math.max(0, this.runningCount(this.providerRunning, provider) - 1);
    if (modelRunning === 0) this.modelRunning.delete(modelKey);
    else this.modelRunning.set(modelKey, modelRunning);
    if (providerRunning === 0) this.providerRunning.delete(provider);
    else this.providerRunning.set(provider, providerRunning);
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If either concurrency ceiling is reached, the agent is queued.
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

    // Reserve both the per-model ceiling and any shared Provider ceiling.
    const reservedModelKey = options.modelKey && this.reserveConcurrency(options.modelKey)
      ? options.modelKey
      : undefined;
    const queued = options.modelKey !== undefined && reservedModelKey === undefined;

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

    if (options.signal?.aborted) {
      record.lifecycle.status = "stopped";
      record.lifecycle.stoppedBy = "user";
      record.lifecycle.completedAt = Date.now();
      record.execution.settled = true;
      if (queued) {
        this.queue = this.queue.filter(entry => entry.id !== id);
        this.settleQueued(id);
      } else if (reservedModelKey) {
        this.releaseConcurrency(reservedModelKey);
      }
      this.safeNotifyComplete(record);
      return id;
    }
    if (options.signal) {
      const onParentAbort = () => this.abort(id, "user");
      options.signal.addEventListener("abort", onParentAbort, { once: true });
      this.parentAbortCleanups.set(id, () => options.signal?.removeEventListener("abort", onParentAbort));
    }

    if (queued) return id;

    // startAgent can throw — clean up record so callers don't see an orphan
    try {
      this.startAgent(id, record, args, reservedModelKey);
    } catch (err) {
      this.detachParentAbort(id);
      if (reservedModelKey) this.releaseConcurrency(reservedModelKey);
      this.agents.delete(id);
      throw err;
    }
    return id;
  }

  /**
   * Actually start an agent (called immediately or from queue drain).
   * reservedModelKey identifies the already-acquired Provider and model ceilings.
   */
  private startAgent(
    id: string,
    record: AgentRecord,
    { pi, ctx, type, prompt, options }: SpawnArgs,
    reservedModelKey?: string,
  ) {
    const debugFault = this.armedDebugFault;
    this.armedDebugFault = undefined;
    record.lifecycle.status = "running";
    record.lifecycle.startedAt = Date.now();
    record.execution.settled = false;

    const promise = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      scopedModels: options.scopedModels,
      maxTurns: options.maxTurns,
      thinkingLevel: options.thinkingLevel,
      thinkingResolved: options.thinkingResolved,
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
        this.detachParentAbort(id);
        if (reservedModelKey) this.releaseConcurrency(reservedModelKey);

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

  private detachParentAbort(id: string): void {
    this.parentAbortCleanups.get(id)?.();
    this.parentAbortCleanups.delete(id);
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

  /** Start queued agents only when both Provider and model ceilings have room. */
  private drainQueue() {
    const started = new Set<string>();
    for (const entry of this.queue) {
      const record = this.agents.get(entry.id);
      if (!record || record.lifecycle.status !== "queued") continue;
      if (!this.reserveConcurrency(entry.modelKey)) continue;

      try {
        this.startAgent(entry.id, record, entry.args, entry.modelKey);
        started.add(entry.id);
      } catch (err) {
        this.detachParentAbort(entry.id);
        this.releaseConcurrency(entry.modelKey);
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
  ): Promise<InteractionResult> {
    const record = this.agents.get(id);
    if (!record) return { accepted: false, reason: "unavailable" };
    if (record.lifecycle.status === "queued") return { accepted: false, reason: "queued" };

    if (record.lifecycle.status === "running") {
      return await this.steer(id, message, images)
        ? { accepted: true }
        : { accepted: false, reason: "unavailable" };
    }

    const session = record.execution.session;
    if (!session || !record.execution.settled || session.isStreaming) {
      return { accepted: false, reason: "unavailable" };
    }

    const reservedModelKey = record.execution.modelKey;
    if (reservedModelKey && !this.reserveConcurrency(reservedModelKey)) {
      return { accepted: false, reason: "concurrency", modelKey: reservedModelKey };
    }

    // Do not alter a fault-bound recovery deadline until this continuation is
    // guaranteed to start. A full concurrency ceiling must leave the exact expiry timer intact.
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
    record.lifecycle.cleanupExpiryPausedMs = undefined;
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
        if (reservedModelKey) this.releaseConcurrency(reservedModelKey);
        record.execution.settled = true;
        this.scheduleRecoveryExpiry(record);
        this.safeNotifyComplete(record);
        this.drainQueue();
      });

    record.execution.promise = promise;
    return { accepted: true };
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
    }
    this.detachParentAbort(record.id);
    if (!wasQueued) record.execution.abortController?.abort();
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

  private hasRecoveryExpiryPause(record: AgentRecord): boolean {
    return record.execution.recoveryExpiryPausedByView === true
      || record.execution.recoveryExpiryPausedByPin === true;
  }

  private setRecoveryExpiryPause(
    record: AgentRecord,
    reason: "view" | "pin",
    paused: boolean,
  ): void {
    const key = reason === "view"
      ? "recoveryExpiryPausedByView"
      : "recoveryExpiryPausedByPin";
    record.execution[key] = paused ? true : undefined;

    if (!needsUserInput(record)) return;
    if (paused) {
      if (record.execution.recoveryExpiryPausedRemainingMs == null) {
        record.execution.recoveryExpiryPausedRemainingMs = this.recoveryRemainingMs(record);
        record.execution.recoveryExpiresAt = undefined;
        this.clearRecoveryExpiry(record.id);
      }
      return;
    }
    if (this.hasRecoveryExpiryPause(record)) return;

    const remaining = record.execution.recoveryExpiryPausedRemainingMs;
    if (remaining == null) return;
    record.execution.recoveryExpiryPausedRemainingMs = undefined;
    record.execution.recoveryExpiresAt = Date.now() + remaining;
    this.scheduleRecoveryExpiry(record);
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
    if (!needsUserInput(record)) return;
    if (this.hasRecoveryExpiryPause(record)) {
      record.execution.recoveryExpiryPausedRemainingMs ??= this.recoveryRemainingMs(record);
      record.execution.recoveryExpiresAt = undefined;
      return;
    }
    if (record.execution.recoveryExpiryPausedRemainingMs != null) {
      record.execution.recoveryExpiresAt = Date.now()
        + record.execution.recoveryExpiryPausedRemainingMs;
      record.execution.recoveryExpiryPausedRemainingMs = undefined;
    }

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
    this.detachParentAbort(id);
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
      if (record.lifecycle.pinnedAt != null) continue;
      const waitingForInput = needsUserInput(record);
      // Ordinary terminal results stay until the LLM has read them. A failed live
      // session has a finite recovery deadline instead, even if its nudge failed.
      if (!waitingForInput && !record.lifecycle.resultConsumed) continue;
      if (waitingForInput) {
        if (record.execution.recoveryExpiryPausedRemainingMs != null) continue;
        if (this.recoveryExpiresAt(record) >= now) continue;
      } else {
        const cleanupExpiresAt = (record.lifecycle.completedAt ?? 0)
          + CLEANUP_AGE_CUTOFF_MS
          + (record.lifecycle.cleanupExpiryPausedMs ?? 0);
        if (cleanupExpiresAt >= now) continue;
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
    for (const id of this.parentAbortCleanups.keys()) this.detachParentAbort(id);
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
