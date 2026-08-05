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
import type { AgentRecord, BackgroundDeliveryMode, SpawnConfig } from "../types.js";
import type { AgentManager, InteractionResult } from "../agents/agent-manager.js";
import { formatResultContent } from "../agents/tool-execution.js";
import {
  appendPendingResult,
  appendResultAck,
  buildResultMessage,
  readResultEntries,
  type PendingResult,
} from "./result-inbox.js";

/** Input for spawn(). Built by each caller from its own validation. */
export interface SpawnIntent extends SpawnConfig {
  type: string;
  prompt: string;
  /** Parent tool-call signal, present only for foreground work. */
  signal?: AbortSignal;
  runInBackground: boolean;
  /** Narrowed to required — all callers resolve this before spawn. */
  graceTurns: number;
}

export interface SpawnResult {
  agentId: string;
  record: AgentRecord;
}

export interface PendingResultUiState {
  count: number;
  label: "pending" | "next-turn";
}

function isParentRunSuccessful(
  messages: readonly { role: string; stopReason?: string; errorMessage?: string }[],
): boolean {
  const last = messages.filter(message => message.role === "assistant").at(-1);
  return !!last
    && last.stopReason !== "error"
    && last.stopReason !== "aborted"
    && last.errorMessage === undefined;
}

function storedResult(record: AgentRecord, delivery: BackgroundDeliveryMode): PendingResult | undefined {
  const result = formatResultContent(record).trim() || "(no output)";
  const parentSessionId = record.execution.resultSessionId;
  if (!parentSessionId) return undefined;
  const sessionModel = record.execution.session?.model;
  const invocation = record.display.invocation;
  return {
    agentId: record.id,
    parentSessionId,
    originEntryId: record.execution.resultOriginEntryId ?? null,
    type: record.display.type,
    status: record.lifecycle.status,
    result,
    error: record.error?.trim() || null,
    provider: sessionModel?.provider ?? invocation?.providerName,
    model: sessionModel?.id ?? invocation?.modelName,
    createdAt: Date.now(),
    deliveryId: randomUUID(),
    delivery,
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
  /** Source of the active parent turn, used to keep auto and next-turn modes isolated. */
  private parentWakeMode: "auto" | "natural" | undefined;
  /** Monotonic Auto-completion version and the snapshot carried by the active parent turn. */
  private autoCompletionVersion = 0;
  private parentWakeAutoCompletionVersion = 0;
  /** Latest parent run outcome, consumed at agent_settled. */
  private parentRunSucceeded = true;
  /** Last wake failed; used only to bound automatic retry at settlement. */
  private lastWakeFailed = false;
  /** Delivery failures stay attached to their result instead of leaking across modes. */
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

  constructor(private manager: AgentManager) {
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
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    intent: SpawnIntent,
  ): Promise<SpawnResult> {
    const { type, prompt, runInBackground, ...spawnOptions } = intent;
    const resultSessionId = runInBackground ? ctx.sessionManager.getSessionId() : undefined;
    const resultOriginEntryId = runInBackground ? ctx.sessionManager.getLeafId() : undefined;
    if (resultOriginEntryId) this.activeBranchIds.add(resultOriginEntryId);
    const agentId = this.manager.spawn(
      pi,
      ctx,
      type,
      prompt,
      runInBackground
        ? { ...spawnOptions, resultSessionId, resultOriginEntryId }
        : {
            ...spawnOptions,
            backgroundDelivery: undefined,
            resultSessionId: undefined,
            resultOriginEntryId: undefined,
          },
    );

    getNavigator()?.ensureTimer();

    const record = this.manager.getRecord(agentId)!;
    if (!runInBackground) {
      await record.execution.promise;
      record.lifecycle.resultConsumed = true;
    }

    return { agentId, record };
  }

  /** Route user input to a running or settled subagent session. */
  async interact(agentId: string, message: string, images?: ImageContent[]): Promise<InteractionResult> {
    const record = this.manager.getRecord(agentId);
    if (!record) return { accepted: false, reason: "unavailable" };

    const result = await this.manager.interact(agentId, message, images);
    if (result.accepted) getNavigator()?.ensureTimer();
    return result;
  }

  /** Persist a background completion and let that completion request a wake-up. */
  onAgentComplete(record: AgentRecord): void {
    const delivery = record.execution?.backgroundDelivery;
    // Manual clear and manager shutdown remove the record before the async run
    // settles. Those completions are intentionally discarded, not re-enqueued.
    if (!delivery || this.disposed || !this.manager.getRecord(record.id)) return;

    const result = storedResult(record, delivery);
    if (!result) return;

    this.fallbackResults.set(result.deliveryId, result);
    record.execution.resultDeliveryId = result.deliveryId;
    this.flushFallbackResults();
    if (this.fallbackResults.has(result.deliveryId)) {
      this.lastWakeFailed = true;
      getNavigator()?.update();
      return;
    }

    if (delivery === "auto") {
      this.lastWakeFailed = false;
      this.requestParentWake();
    }
    getNavigator()?.update();
  }

  /** Inject pending results into a normal parent prompt. */
  prepareBeforeAgentStart(): ReturnType<typeof buildResultMessage> {
    if (this.disposed) return undefined;
    this.parentRunPhase = "preflight";
    this.flushFallbackResults();
    const autoOnly = this.parentWakeActive && this.parentWakeMode === "auto";
    const results = this.eligiblePendingResults()
      .filter(result => !autoOnly || result.delivery === "auto");
    const message = buildResultMessage(results);
    if (!message) return undefined;

    this.parentWakeActive = true;
    this.parentWakeMode = autoOnly ? "auto" : "natural";
    this.parentWakeAutoCompletionVersion = this.autoCompletionVersion;
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
    const hasNewAutoCompletion = this.autoCompletionVersion > this.parentWakeAutoCompletionVersion;
    const hasAutoPending = this.eligiblePendingResults().some(result => result.delivery === "auto");
    const hasNewWakeOpportunity = hasNewAutoCompletion && hasAutoPending;
    this.parentRunPhase = "idle";
    this.parentWakeActive = false;
    this.parentWakeMode = undefined;
    this.parentTurnResultIds.clear();

    let wakeAfterSettle = false;
    if (succeeded) {
      this.lastWakeFailed = false;
      const acknowledged = ids.length === 0 || this.acknowledge(ids);
      const failedAutoPending = this.pendingState().some(result => result.delivery === "auto");
      this.lastWakeFailed ||= deliveryFailed && failedAutoPending;
      // A successful acknowledgement drains Auto results completed while this
      // turn ran. A failed delivery needs another persisted Auto completion or
      // an explicit lifecycle recovery event before it can try again.
      wakeAfterSettle = (!deliveryFailed && acknowledged) || hasNewWakeOpportunity;
    } else {
      this.lastWakeFailed = true;
      for (const deliveryId of ids) {
        if (this.pendingResults.has(deliveryId)) this.failedResultIds.add(deliveryId);
      }
      // Do not retry the same failed delivery by itself. An Auto completion
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
    this.parentWakeMode = undefined;
    this.parentTurnResultIds.clear();
    this.parentWakeAutoCompletionVersion = this.autoCompletionVersion;
    this.lastWakeFailed = false;
    this.activateEligiblePending();
    getNavigator()?.update();
  }

  /** Return only exceptional Auto state or intentional next-turn waiting state. */
  pendingResultUiState(): PendingResultUiState | undefined {
    const visible = this.pendingState()
      .filter(result => !this.parentTurnResultIds.has(result.deliveryId));
    if (visible.length === 0) return undefined;

    const hasFailedDelivery = visible.some(result =>
      this.failedResultIds.has(result.deliveryId)
      || this.fallbackResults.has(result.deliveryId)
    );
    if (hasFailedDelivery) return { count: visible.length, label: "pending" };

    const nextTurnWaiting = visible.filter(result => result.delivery === "next-turn");
    return nextTurnWaiting.length > 0
      ? { count: nextTurnWaiting.length, label: "next-turn" }
      : undefined;
  }

  /** Read a durable result after its volatile AgentManager record was removed. */
  getStoredResult(agentId: string): PendingResult | undefined {
    const fallback = [...this.fallbackResults.values()].filter(result => result.agentId === agentId).at(-1);
    return fallback ?? this.latestResults.get(agentId);
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
    if (this.eligiblePendingResults().some(result => result.delivery === "auto")) {
      this.requestParentWake();
    }
  }

  private flushFallbackResults(): void {
    const pi = getPiInstance();
    for (const [deliveryId, result] of this.fallbackResults) {
      if (!appendPendingResult(pi, result)) {
        this.failedResultIds.add(deliveryId);
        continue;
      }
      this.fallbackResults.delete(deliveryId);
      // Recovered Auto persistence is still blocked until an Auto event re-arms its wake.
      if (result.delivery === "next-turn") this.failedResultIds.delete(deliveryId);
      if (result.delivery === "auto") this.autoCompletionVersion++;
      this.pendingResults.set(deliveryId, result);
      this.latestResults.set(result.agentId, result);
      const record = this.manager.getRecord(result.agentId);
      if (record?.execution.resultDeliveryId === deliveryId) record.lifecycle.resultPersisted = true;
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
    const autoPending = this.eligiblePendingResults()
      .filter(result => result.delivery === "auto");
    const message = buildResultMessage(autoPending);
    if (!message) return;
    const previousTurnIds = this.parentTurnResultIds;
    const previousWakeMode = this.parentWakeMode;
    const previousRunSucceeded = this.parentRunSucceeded;
    this.parentWakeActive = true;
    this.parentWakeMode = "auto";
    this.parentWakeAutoCompletionVersion = this.autoCompletionVersion;
    this.parentRunSucceeded = false;
    this.parentTurnResultIds = new Set([
      ...previousTurnIds,
      ...autoPending.map(result => result.deliveryId),
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
      this.parentWakeMode = previousWakeMode;
      this.parentRunSucceeded = previousRunSucceeded;
      this.parentTurnResultIds = previousTurnIds;
      for (const result of autoPending) this.failedResultIds.add(result.deliveryId);
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
      const record = result ? this.manager.getRecord(result.agentId) : undefined;
      if (record?.execution.resultDeliveryId === deliveryId) record.lifecycle.resultConsumed = true;
    }
    return true;
  }
}
