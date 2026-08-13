import { randomUUID } from "node:crypto";
import {
  getNavigator,
  getPiInstance,
  getSessionCtx,
  setFallbackResults,
  takeFallbackResults,
} from "../shell.js";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AgentSnapshot,
  InteractionResult,
  SubagentRuntime,
} from "../modules/subagent-runtime/public.js";
import type { SpawnIntent, SpawnResult } from "./coordinator-api.js";
import { formatResultContent } from "../agents/tool-execution.js";
import {
  appendPendingResult,
  appendResultAck,
  buildResultMessage,
  readResultEntries,
  type PendingResult,
} from "./result-inbox.js";

export type { SpawnIntent, SpawnResult } from "./coordinator-api.js";

function isParentRunSuccessful(
  messages: readonly { role: string; stopReason?: string; errorMessage?: string }[],
): boolean {
  const last = messages.filter(message => message.role === "assistant").at(-1);
  return !!last
    && last.stopReason !== "error"
    && last.stopReason !== "aborted"
    && last.errorMessage === undefined;
}

function storedResult(record: AgentSnapshot): PendingResult | undefined {
  const result = formatResultContent(record).trim() || "(no output)";
  const parentSessionId = record.resultSessionId;
  if (!parentSessionId) return undefined;
  const invocation = record.invocation;
  return {
    agentId: record.id,
    parentSessionId,
    originEntryId: record.resultOriginEntryId ?? null,
    type: record.type,
    status: record.status,
    result,
    error: record.error?.trim() || null,
    provider: invocation?.providerName,
    model: invocation?.modelName,
    createdAt: record.completedAt ?? Date.now(),
    deliveryId: randomUUID(),
  };
}

/**
 * Single spawn-and-delivery coordinator.
 *
 * Completion persistence and parent wake-up are deliberately separate. Every
 * background completion is durable, while concurrent completions share one
 * parent wake-up so a provider error cannot turn into N queued parent turns.
 */
function parentSessionId(): string {
  return getSessionCtx().sessionManager.getSessionId();
}

export class SpawnCoordinator {
  /** Parent lifecycle phase distinguishes idle preflight from settled-idle gaps. */
  private parentRunPhase: "idle" | "preflight" | "running" | "settling" = "idle";
  /** True while one parent turn is carrying a result delivery request. */
  private parentWakeActive = false;
  /** Result IDs presented by the currently active parent turn. */
  private parentTurnResultIds = new Set<string>();
  /** Monotonic persisted-completion version and the snapshot carried by the active parent turn. */
  private completionVersion = 0;
  private parentWakeCompletionVersion = 0;
  /** Latest parent run outcome, consumed at agent_settled. */
  private parentRunSucceeded = true;
  /** Last wake failed; used only to bound automatic retry at settlement. */
  private lastWakeFailed = false;
  /** Delivery failures stay attached to their result. */
  private failedResultIds = new Set<string>();
  /** Results restored once from the parent session, then maintained incrementally. */
  private pendingResults = new Map<string, PendingResult>();
  private latestResults = new Map<string, PendingResult>();
  /** Active branch ancestry, refreshed only on session start/tree navigation. */
  private activeBranchIds = new Set<string>();
  /** Results retained in memory while the parent session append is unavailable. */
  private fallbackResults = new Map<string, PendingResult>();
  /** Set during dispose to prevent stale pi usage after session replacement. */
  private disposed = false;

  constructor(private manager: SubagentRuntime) {
    const entries = readResultEntries(getSessionCtx());
    this.pendingResults = entries.pending;
    this.latestResults = entries.latest;
    this.refreshActiveBranch();
    for (const result of takeFallbackResults(parentSessionId())) {
      this.fallbackResults.set(result.deliveryId, result);
    }
  }

  /** Spawn + wire tracking + (foreground) await. */
  async spawn(
    _pi: ExtensionAPI,
    ctx: ExtensionContext,
    intent: SpawnIntent,
  ): Promise<SpawnResult> {
    const { type, prompt, runInBackground, ...spawnOptions } = intent;
    const resultSessionId = runInBackground ? ctx.sessionManager.getSessionId() : undefined;
    const resultOriginEntryId = runInBackground ? ctx.sessionManager.getLeafId() : undefined;
    if (resultOriginEntryId) this.activeBranchIds.add(resultOriginEntryId);
    const spawned = await this.manager.execute({
      kind: "spawn",
      type,
      prompt,
      description: spawnOptions.description,
      acceptedPolicy: spawnOptions.acceptedPolicy,
      worktreePath: spawnOptions.worktreePath,
      parentCwd: spawnOptions.worktreePath ? ctx.cwd : undefined,
      invocation: spawnOptions.invocation,
      resultSessionId: runInBackground ? resultSessionId : undefined,
      resultOriginEntryId: runInBackground ? resultOriginEntryId : undefined,
      parentAborted: spawnOptions.signal?.aborted === true,
    });
    if (!spawned.ok || !spawned.snapshot) {
      throw new Error(spawned.ok ? "Spawn did not return a snapshot." : spawned.error.message);
    }
    const agentId = spawned.snapshot.id;
    if (spawnOptions.signal && !spawnOptions.signal.aborted) {
      spawnOptions.signal.addEventListener("abort", () => {
        this.manager.stop(agentId, "user");
      }, { once: true });
    }

    getNavigator()?.ensureTimer();

    if (!runInBackground) {
      await this.manager.waitUntilSettled(agentId);
      this.manager.markResult(agentId, { consumed: true });
    }

    return { agentId, snapshot: this.manager.getSnapshot(agentId) ?? spawned.snapshot };
  }

  /** Route user input to a running or settled subagent session. */
  async interact(agentId: string, message: string, images?: ImageContent[]): Promise<InteractionResult> {
    const record = this.manager.getSnapshot(agentId);
    if (!record) return { accepted: false, reason: "unavailable" };

    const interacted = await this.manager.execute({
      kind: "interact",
      id: agentId,
      message,
      images: images as unknown[] | undefined,
    });
    const result = interacted.ok && interacted.interaction
      ? interacted.interaction
      : { accepted: false as const, reason: "unavailable" as const };
    if (result.accepted) getNavigator()?.ensureTimer();
    return result;
  }

  /** Persist a background completion and let that completion request a wake-up. */
  onAgentComplete(record: AgentSnapshot): void {
    // Manual clear and manager shutdown remove the record before the async run
    // settles. Those completions are intentionally discarded, not re-enqueued.
    if (!record.resultSessionId || this.disposed || !this.manager.getSnapshot(record.id)) return;

    const result = storedResult(record);
    if (!result) return;

    this.fallbackResults.set(result.deliveryId, result);
    this.manager.markResult(record.id, { deliveryId: result.deliveryId });
    const completionVersion = this.completionVersion;
    this.flushFallbackResults();
    if (this.fallbackResults.has(result.deliveryId)) {
      this.lastWakeFailed = true;
      if (this.completionVersion > completionVersion) this.requestParentWake();
      getNavigator()?.update();
      return;
    }

    this.lastWakeFailed = false;
    this.requestParentWake();
    getNavigator()?.update();
  }

  /** Inject pending results into a normal parent prompt. */
  prepareBeforeAgentStart(): ReturnType<typeof buildResultMessage> {
    if (this.disposed) return undefined;
    this.parentRunPhase = "preflight";
    this.flushFallbackResults();
    const results = this.eligiblePendingResults();
    const message = buildResultMessage(results);
    if (!message) return undefined;

    this.parentWakeActive = true;
    this.parentWakeCompletionVersion = this.completionVersion;
    this.parentRunSucceeded = false;
    this.parentTurnResultIds = new Set(results.map(result => result.deliveryId));
    this.lastWakeFailed = false;
    return message;
  }

  /** Flush a completion that landed after preflight but before the run started. */
  onParentAgentStart(): void {
    if (this.disposed) return;
    this.parentRunPhase = "running";
    this.requestParentWake();
  }

  /** Track the outcome of the current parent agent run. */
  onParentAgentEnd(messages: readonly { role: string; stopReason?: string; errorMessage?: string }[]): void {
    this.parentRunPhase = "settling";
    this.parentRunSucceeded = isParentRunSuccessful(messages);
  }

  /** Finalize delivery after Pi has exhausted retries and queued continuations. */
  onParentSettled(): void {
    if (this.disposed) return;

    const ids = [...this.parentTurnResultIds];
    const succeeded = this.parentRunSucceeded;
    const deliveryFailed = this.lastWakeFailed;
    const hasNewCompletion = this.completionVersion > this.parentWakeCompletionVersion;
    const hasPending = this.eligiblePendingResults().length > 0;
    const hasNewWakeOpportunity = hasNewCompletion && hasPending;
    this.parentRunPhase = "idle";
    this.parentWakeActive = false;
    this.parentTurnResultIds.clear();

    let wakeAfterSettle = false;
    if (succeeded) {
      this.lastWakeFailed = false;
      const acknowledged = ids.length === 0 || this.acknowledge(ids);
      this.lastWakeFailed ||= deliveryFailed && this.pendingState().length > 0;
      // A successful acknowledgement drains results completed while this turn
      // ran. A failed delivery needs another persisted completion or
      // an explicit lifecycle restoration event before it can try again.
      wakeAfterSettle = (!deliveryFailed && acknowledged) || hasNewWakeOpportunity;
    } else {
      this.lastWakeFailed = true;
      for (const deliveryId of ids) {
        if (this.pendingResults.has(deliveryId)) this.failedResultIds.add(deliveryId);
      }
      // Do not retry the same failed delivery by itself. A completion
      // during that failed turn is a new event and may request one later wake.
      wakeAfterSettle = hasNewWakeOpportunity;
    }
    if (wakeAfterSettle) {
      queueMicrotask(() => {
        this.requestParentWake();
        getNavigator()?.update();
      });
    }
    getNavigator()?.update();
  }

  /** Re-arm eligible delivery after a session reload without resuming child sessions. */
  restorePending(): void {
    if (this.disposed) return;
    this.activateEligiblePending();
    getNavigator()?.update();
  }

  /** Refresh branch-local visibility after /tree navigation. */
  onSessionTree(): void {
    if (this.disposed) return;
    this.refreshActiveBranch();
    this.parentRunPhase = "idle";
    this.parentWakeActive = false;
    this.parentTurnResultIds.clear();
    this.parentWakeCompletionVersion = this.completionVersion;
    this.lastWakeFailed = false;
    this.activateEligiblePending();
    getNavigator()?.update();
  }

  /** Return only exceptional pending state; normal in-flight delivery stays hidden. */
  pendingResultCount(): number | undefined {
    const visible = this.pendingState()
      .filter(result => !this.parentTurnResultIds.has(result.deliveryId));
    if (visible.length === 0) return undefined;

    const hasFailedDelivery = visible.some(result =>
      this.failedResultIds.has(result.deliveryId)
      || this.fallbackResults.has(result.deliveryId)
    );
    return hasFailedDelivery ? visible.length : undefined;
  }

  /** Read the record's current completion, or the latest durable result after record cleanup. */
  getStoredResult(agentId: string): PendingResult | undefined {
    const deliveryId = this.manager.getSnapshot(agentId)?.resultDeliveryId;
    const latest = this.latestResults.get(agentId);
    if (deliveryId) {
      return this.fallbackResults.get(deliveryId)
        ?? this.pendingResults.get(deliveryId)
        ?? (latest?.deliveryId === deliveryId ? latest : undefined);
    }

    const fallback = [...this.fallbackResults.values()]
      .filter(result => result.agentId === agentId)
      .reduce<PendingResult | undefined>(
        (newest, result) => !newest || result.createdAt >= newest.createdAt ? result : newest,
        undefined,
      );
    if (!fallback) return latest;
    if (!latest || fallback.createdAt >= latest.createdAt) return fallback;
    return latest;
  }

  /** Include an explicitly read durable result in the current parent turn's acknowledgement. */
  markResultPresented(deliveryId: string): void {
    this.flushFallbackResults();
    if (this.pendingResults.has(deliveryId)) this.parentTurnResultIds.add(deliveryId);
  }

  /** Dispose delivery state; parent session entries remain durable. */
  dispose(): void {
    // Give a stale runtime one final chance to persist results before the
    // composition root drops its in-memory fallback. There is no second store
    // to write after the parent session itself is being replaced.
    this.flushFallbackResults();
    // Keep unsuccessful fallbacks in the composition-root shell so an
    // in-process session reload can retry them with the new coordinator.
    setFallbackResults(parentSessionId(), [...this.fallbackResults.values()]);
    this.disposed = true;
  }

  private pendingState(): PendingResult[] {
    return [
      ...this.pendingResults.values(),
      ...this.fallbackResults.values(),
    ].filter(result => this.belongsToActiveBranch(result));
  }

  private refreshActiveBranch(): void {
    this.activeBranchIds = new Set(
      getSessionCtx().sessionManager.getBranch().map(entry => entry.id),
    );
  }

  private belongsToActiveBranch(result: PendingResult): boolean {
    return result.parentSessionId === parentSessionId()
      && (result.originEntryId === null || this.activeBranchIds.has(result.originEntryId));
  }

  private eligiblePendingResults(): PendingResult[] {
    return [...this.pendingResults.values()].filter(result => this.belongsToActiveBranch(result));
  }

  private activateEligiblePending(): void {
    this.flushFallbackResults();
    if (this.eligiblePendingResults().length > 0) this.requestParentWake();
  }

  private flushFallbackResults(): void {
    const pi = getPiInstance();
    for (const [deliveryId, result] of this.fallbackResults) {
      if (!appendPendingResult(pi, result)) {
        this.failedResultIds.add(deliveryId);
        continue;
      }
      this.fallbackResults.delete(deliveryId);
      this.completionVersion++;
      this.pendingResults.set(deliveryId, result);
      const latest = this.latestResults.get(result.agentId);
      if (!latest || result.createdAt >= latest.createdAt) this.latestResults.set(result.agentId, result);
      const record = this.manager.getSnapshot(result.agentId);
      if (record?.resultDeliveryId === deliveryId) {
        this.manager.markResult(result.agentId, { persisted: true });
      }
    }
  }

  /** One idempotent wake request; later completions only add to the session inbox. */
  private requestParentWake(): void {
    if (
      this.disposed
      || this.parentWakeActive
      || this.parentRunPhase === "preflight"
      || this.parentRunPhase === "settling"
    ) return;
    this.flushFallbackResults();
    const pi = getPiInstance();
    const pending = this.eligiblePendingResults();
    const message = buildResultMessage(pending);
    if (!message) return;
    const previousTurnIds = this.parentTurnResultIds;
    const previousRunSucceeded = this.parentRunSucceeded;
    this.parentWakeActive = true;
    this.parentWakeCompletionVersion = this.completionVersion;
    this.parentRunSucceeded = false;
    this.parentTurnResultIds = new Set([
      ...previousTurnIds,
      ...pending.map(result => result.deliveryId),
    ]);
    this.lastWakeFailed = false;

    try {
      if (this.parentRunPhase === "running" || !getSessionCtx().isIdle()) {
        pi.sendMessage(message, { deliverAs: "followUp" });
      } else {
        pi.sendMessage(message, { triggerTurn: true });
      }
    } catch {
      this.parentWakeActive = false;
      this.parentRunSucceeded = previousRunSucceeded;
      this.parentTurnResultIds = previousTurnIds;
      for (const result of pending) this.failedResultIds.add(result.deliveryId);
      this.lastWakeFailed = true;
      getNavigator()?.update();
    }
  }

  private acknowledge(ids: readonly string[]): boolean {
    const pi = getPiInstance();
    if (!appendResultAck(pi, parentSessionId(), ids)) {
      for (const deliveryId of ids) this.failedResultIds.add(deliveryId);
      this.lastWakeFailed = true;
      return false;
    }
    for (const deliveryId of ids) {
      const result = this.pendingResults.get(deliveryId);
      this.pendingResults.delete(deliveryId);
      this.failedResultIds.delete(deliveryId);
      const record = result ? this.manager.getSnapshot(result.agentId) : undefined;
      if (record?.resultDeliveryId === deliveryId) {
        this.manager.markResult(result!.agentId, { consumed: true });
      }
    }
    return true;
  }
}
