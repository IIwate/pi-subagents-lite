/**
 * agent-manager.ts — Tracks agents, per-model concurrency, background execution.
 *
 * Supports per-model and per-provider concurrency limits with queuing.
 */

import { randomUUID } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { continueAgentSession, runAgent } from "./agent-runner.js";
import { AgentOutputLog } from "./output-file.js";
import { getStore } from "../shell.js";
import {
  type AgentRecord,
  type AgentStatus,
  type CompactionInfo,
  type RunCallbacks,
  type StopInitiator,
  SHORT_ID_LENGTH,
  type SpawnConfig,
  type ToolActivity,
} from "../types.js";
import type { SubagentType } from "./types.js";
import { addUsage, getLifetimeTotal, getSessionContextPercent, type AgentUsage } from "./usage.js";
import { errorMessage } from "../utils.js";

/** How often to check for expired agent records (milliseconds). */
const CLEANUP_INTERVAL_MS = 60_000;

/** Age after which a completed agent record is evicted (milliseconds). */
const CLEANUP_AGE_CUTOFF_MS = 10 * 60_000;

/** 等待子会话 shutdown handler 的上限，超时后照常 dispose（milliseconds）。 */
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

type OnAgentComplete = (record: AgentRecord) => void;
type OnAgentStart = (record: AgentRecord) => void;
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

export interface SpawnOptions extends SpawnConfig, RunCallbacks {
  isBackground?: boolean;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onRemove?: OnAgentRemove;

  /** Session-level cumulative agent cost. Survives agent eviction. */
  private totalAgentCost = 0;

  /** Cost already added to the session total for each agent. */
  private accountedCosts = new Map<string, number>();

  /** 已清除运行中代理的成本快照，保留到最终 usage 返回。 */
  private removedCostSnapshots = new Map<string, number>();

  /** Per-model concurrency slots keyed by "provider/modelId". */
  private concurrencySlots = new Map<string, ConcurrencySlot>();

  /** Per-provider concurrency slots — shared pool for all models from a provider. */
  private providerSlots = new Map<string, ConcurrencySlot>();

  /** Default concurrency limit for models not in the slots map. */
  private defaultConcurrency: number;

  /** Queue of agents waiting to start, keyed by modelKey. */
  private queue: { id: string; modelKey: string; args: SpawnArgs }[] = [];

  /** In-flight child session teardowns, awaited by dispose() so cleanup is not cut short. */
  private closing = new Set<Promise<void>>();

  /** dispose() 已启动。防止 shutdown 链意外重入时并发修改 closing 集合。 */
  private disposing = false;

  constructor(
    onComplete?: OnAgentComplete,
    concurrency?: ConcurrencyConfig,
    onStart?: OnAgentStart,
    private bufferSize: number = 0,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
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
        this.queue.push({ id, modelKey: options.modelKey, args });
      } else {
        concurrencySlot = slot;
      }
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
        worktreePath: options.worktreePath,
        worktreeLabel: options.worktreeLabel,
      },
      execution: {
        abortController,
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

    record.lifecycle.status = "running";
    record.lifecycle.startedAt = Date.now();
    record.execution.settled = false;

    // Create output log for this agent (creates file + writes [USER] entry)
    record.execution.outputLog = new AgentOutputLog(id, prompt, undefined, this.bufferSize);
    record.display.outputFile = record.execution.outputLog.path;

    this.onStart?.(record);

    // Wire parent abort signal to stop the subagent when the parent is interrupted
    if (options.signal) {
      options.signal.addEventListener("abort", () => this.abort(id, "agent"), { once: true });
    }

    const promise = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      maxTurns: options.maxTurns,
      maxTokens: options.maxTokens,
      thinkingLevel: options.thinkingLevel,
      cwd: options.worktreePath,
      graceTurns: options.graceTurns,
      signal: record.execution.abortController!.signal,
      ...this.createRecordCallbacks(record, options),
      onTurnEnd: (turnCount) => {
        record.stats.turnCount = turnCount;
        options.onTurnEnd?.(turnCount);
      },
      onTextDelta: options.onTextDelta,
      onSessionCreated: (session) => {
        record.execution.session = session;
        // Snapshot effective model/thinking for widget display (session may inherit settings defaults).
        const inv = record.display.invocation ?? {};
        if (!inv.modelName && session.model?.id) inv.modelName = session.model.id;
        if (!inv.thinkingLevel && session.thinkingLevel) inv.thinkingLevel = session.thinkingLevel;
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
        // Attach output log stream to session
        if (record.execution.outputLog) {
          record.execution.outputLog.attach(session);
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(({ responseText, session, aborted, turnLimited }) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.lifecycle.status !== "stopped") {
          record.lifecycle.status = aborted ? "aborted" : turnLimited ? "turn_limited" : "completed";
        }
        record.result = responseText;
        record.execution.session = session;
        record.stats.contextPercent = getSessionContextPercent(session);
        record.lifecycle.completedAt ??= Date.now();
        return responseText;
      })
      .catch((err) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.lifecycle.status !== "stopped") {
          record.lifecycle.status = "error";
        }
        record.error = errorMessage(err);
        record.lifecycle.completedAt ??= Date.now();
        return "";
      })
      .finally(() => {
        // Finalize output log with final stats
        if (record.execution.outputLog) {
          try {
            record.execution.outputLog.finalize({
              turnCount: record.stats.turnCount ?? 0,
              toolUseCount: record.stats.toolUses,
              totalTokens: getLifetimeTotal(record.stats.lifetimeUsage),
              cost: record.stats.lifetimeUsage.cost,
            });
          } catch { /* ignore */ }
        }

        // Decrement per-model concurrency count
        if (concurrencySlot) concurrencySlot.running--;

        record.execution.settled = true;
        this.safeNotifyComplete(record);
        this.drainQueue();
      });

    record.execution.promise = promise;
  }

  /** Notify completion callback, ignoring any errors. */
  private safeNotifyComplete(record: AgentRecord): void {
    const retained = this.agents.has(record.id);
    const removedSnapshot = this.removedCostSnapshots.get(record.id);
    if (retained || removedSnapshot !== undefined) {
      const previousCost = retained
        ? (this.accountedCosts.get(record.id) ?? 0)
        : (removedSnapshot ?? 0);
      const currentCost = record.stats.lifetimeUsage.cost;
      this.totalAgentCost += Math.max(0, currentCost - previousCost);
      if (retained) this.accountedCosts.set(record.id, currentCost);
      else this.removedCostSnapshots.delete(record.id);
    }
    try { this.onComplete?.(record); } catch { /* ignore */ }
  }

  setOnComplete(cb: OnAgentComplete): void {
    this.onComplete = cb;
  }

  setOnRemove(cb: OnAgentRemove): void {
    this.onRemove = cb;
  }

  /** Get the session-level cumulative agent cost. Survives agent eviction. */
  getTotalAgentCost(): number {
    return this.totalAgentCost;
  }

  /** Cost accumulated by an agent since its last settled accounting point. */
  getUnaccountedAgentCost(id: string): number {
    const record = this.agents.get(id);
    if (!record) return 0;
    return Math.max(
      0,
      record.stats.lifetimeUsage.cost - (this.accountedCosts.get(id) ?? 0),
    );
  }

  /**
   * Build common record-tracking callbacks shared by startAgent.
   * Updates the record's toolUses, lifetimeUsage, and compactionCount.
   * When options are provided, also forwards events to the caller.
   */
  private createRecordCallbacks(
    record: AgentRecord,
    options?: Pick<SpawnOptions, "onToolActivity" | "onAssistantUsage" | "onCompaction">,
  ): {
    onToolActivity: (activity: ToolActivity) => void;
    onAssistantUsage: (usage: AgentUsage) => void;
    onCompaction: (info: CompactionInfo) => void;
  } {
    return {
      onToolActivity: (activity) => {
        if (activity.type === "end") record.stats.toolUses++;
        options?.onToolActivity?.(activity);
      },
      onAssistantUsage: (usage) => {
        // vLLM doesn't report cache hits, so usage.input is full prompt_tokens.
        // Estimate new tokens as delta from previous message's input.
        const deltaEnabled = getStore().agent.deltaInputTokens;
        const cacheRead = usage.cacheRead;
        let inputDelta = usage.input;
        if (deltaEnabled && cacheRead === 0 && record.stats.prevInputTokens != null && usage.input > record.stats.prevInputTokens) {
          inputDelta = usage.input - record.stats.prevInputTokens;
        }
        record.stats.prevInputTokens = usage.input;

        addUsage(record.stats.lifetimeUsage, { ...usage, input: inputDelta });
        options?.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.stats.compactionCount++;
        options?.onCompaction?.(info);
      },
    };
  }

  /** Start queued agents up to the per-model concurrency limits. */
  private drainQueue() {
    const started = new Set<string>();
    for (const entry of this.queue) {
      const record = this.agents.get(entry.id);
      if (!record || record.lifecycle.status !== "queued") continue;

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
        started.add(entry.id);
        this.safeNotifyComplete(record);
      }
    }
    this.queue = this.queue.filter(e => !started.has(e.id));
  }


  /**
   * Send a steering message to a running agent.
   * If the session hasn't been created yet, the message is queued.
   */
  async steer(id: string, message: string, images?: ImageContent[]): Promise<boolean> {
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
    callbacks: RunCallbacks = {},
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

    const previousTurns = record.stats.turnCount ?? 0;
    const abortController = new AbortController();
    const abortSession = () => { void session.abort(); };
    abortController.signal.addEventListener("abort", abortSession, { once: true });

    record.execution.abortController = abortController;
    record.execution.settled = false;
    record.lifecycle.status = "running";
    record.lifecycle.startedAt = Date.now();
    record.lifecycle.completedAt = undefined;
    record.lifecycle.resultConsumed = undefined;
    record.error = undefined;
    try { record.execution.outputLog?.resume(session); } catch { /* best effort */ }

    const trackedCallbacks = this.createRecordCallbacks(record, callbacks);
    const promise = continueAgentSession(session, message, {
      ...trackedCallbacks,
      images,
      maxTurns: record.stats.maxTurns,
      graceTurns: record.execution.graceTurns,
      onTextDelta: callbacks.onTextDelta,
      onTurnEnd: (turnCount) => {
        record.stats.turnCount = previousTurns + turnCount;
        callbacks.onTurnEnd?.(turnCount);
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
        record.error = errorMessage(err);
        record.lifecycle.completedAt ??= Date.now();
        record.lifecycle.resultConsumed = true;
        return "";
      })
      .finally(() => {
        abortController.signal.removeEventListener("abort", abortSession);
        try {
          record.execution.outputLog?.finalize({
            turnCount: record.stats.turnCount ?? 0,
            toolUseCount: record.stats.toolUses,
            totalTokens: getLifetimeTotal(record.stats.lifetimeUsage),
            cost: record.stats.lifetimeUsage.cost,
          });
        } catch { /* best effort */ }
        if (concurrencySlot) concurrencySlot.running--;
        record.execution.settled = true;
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
    // 先结算当前已知成本；运行中的请求可能在 clear() 后才返回最终 usage，
    // 因此保留快照，让 settle 回调只补记迟到的差额。
    this.totalAgentCost += this.getUnaccountedAgentCost(id);
    if (!record.execution.settled && record.execution.promise) {
      this.removedCostSnapshots.set(id, record.stats.lifetimeUsage.cost);
    }
    this.removeRecord(id, record);
    return true;
  }

  /**
   * Stop an agent by aborting its session or removing it from the queue.
   * Returns true if the agent was stopped, false if it wasn't running/queued.
   */
  private stopAgent(record: AgentRecord, stoppedBy?: StopInitiator): boolean {
    if (record.lifecycle.status === "queued") {
      this.queue = this.queue.filter(q => q.id !== record.id);
    } else if (record.lifecycle.status !== "running") {
      return false;
    } else {
      record.execution.abortController?.abort();
    }
    record.lifecycle.status = "stopped";
    record.lifecycle.stoppedBy = stoppedBy;
    record.lifecycle.completedAt = Date.now();
    return true;
  }

  /**
   * Emit session_shutdown to a child session's extensions, then dispose it.
   *
   * AgentSession.dispose() does not emit session_shutdown, so extensions holding
   * session-scoped resources (processes, sockets, watchers) never release them
   * when a subagent is cleared, evicted, or killed with the parent. Subagents run
   * their own extension instances, so the parent's shutdown does not cover them.
   *
   * emit() 串行 await 每个 handler 且不设超时，任一子扩展的 handler 挂起都会让
   * 父进程退出流程永久卡死（events.ts 的 session_shutdown → dispose() → 宿主
   * 的 process.exit 再也跑不到）。因此对 emit 单独限时，超时后仍执行
   * session.dispose() 释放本地资源。
   *
   * 依赖 index.ts 的 isInsideSubagentSpawn() 早退：子会话内的本扩展实例不注册
   * session_shutdown 监听，所以这里的 emit 不会递归回 dispose()。
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
    const session = record.execution.session;
    record.execution.session = undefined;
    this.agents.delete(id);
    this.accountedCosts.delete(id);
    if (session) void this.closeSession(session);
    try { this.onRemove?.(record); } catch { /* ignore */ }
  }

  private cleanup() {
    const cutoff = Date.now() - CLEANUP_AGE_CUTOFF_MS;
    for (const [id, record] of this.agents) {
      if (!isTerminalStatus(record.lifecycle.status)) continue;
      if ((record.lifecycle.completedAt ?? 0) >= cutoff) continue;
      // Keep the record until the LLM has read the result (foreground return or
      // background nudge). Otherwise a completed background agent can be wiped
      // before its nudge is emitted.
      if (!record.lifecycle.resultConsumed) continue;
      this.removeRecord(id, record);
    }
  }

  async dispose() {
    if (this.disposing) return;
    this.disposing = true;
    clearInterval(this.cleanupInterval);
    this.queue = [];
    for (const record of this.agents.values()) {
      const session = record.execution.session;
      record.execution.session = undefined;
      if (session) void this.closeSession(session);
    }
    this.agents.clear();
    this.accountedCosts.clear();
    await Promise.all(this.closing);
  }
}
