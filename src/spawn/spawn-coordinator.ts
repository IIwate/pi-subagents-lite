/**
 * spawn-coordinator.ts — Coordinates spawn lifecycles and durable parent result delivery.
 */

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
import type { AgentRecord, SpawnConfig } from "../types.js";
import type { AgentManager, InteractionResult } from "../agents/agent-manager.js";
import {
  formatSubagentDelivery,
  extractDeliverableMessages,
  type DeliverableMessage,
} from "../prompt/subagent-delivery.js";
import { formatResultContent } from "../agents/tool-execution.js";
import {
  appendPendingResult,
  appendResultAck,
  buildResultMessage,
  deriveResultStateFromEntries,
  readDurableLogState,
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
  detached?: boolean;
}

function storedResult(record: AgentRecord): PendingResult | undefined {
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
    createdAt: record.lifecycle.completedAt ?? Date.now(),
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
export class SpawnCoordinator {
  private readonly sessionId: string;
  private readonly sessionFile: string | undefined;
  private lifecycleVersion = 0;
  /** Parent lifecycle phase distinguishes idle preflight from settled-idle gaps. */
  private parentRunPhase: "idle" | "preflight" | "running" | "settling" = "idle";
  /** True while one parent turn is carrying a result delivery request. */
  private parentWakeActive = false;
  /** In-flight delivery IDs currently dispatched to prevent concurrent duplicate sends. */
  private inFlightDeliveryIds = new Set<string>();
  /** Only receipts verified in the session file can establish delivery. */
  private deliveredResultIds = new Set<string>();
  private acknowledgedResultIds = new Set<string>();
  /** Monotonic persisted-completion version and the snapshot carried by the active parent turn. */
  private completionVersion = 0;
  private parentWakeCompletionVersion = 0;
  /** Delivery failures stay attached to their result. */
  private failedResultIds = new Set<string>();
  /** Results restored once from the parent session, then maintained incrementally. */
  private pendingResults = new Map<string, PendingResult>();
  private latestResults = new Map<string, PendingResult>();
  /** Active branch ancestry, refreshed only on session start/tree navigation. */
  private activeBranchIds = new Set<string>();
  /** Results retained in memory while the parent session append is unavailable. */
  private fallbackResults = new Map<string, PendingResult>();
  /** In-flight reconciliation promise for merging concurrent calls. */
  private reconcilingPromise: Promise<boolean> | null = null;
  private reconcileQueued = false;
  /** Set during dispose to prevent stale pi usage after session replacement. */
  private disposed = false;

  constructor(private manager: AgentManager) {
    const ctx = getSessionCtx();
    this.sessionId = ctx.sessionManager.getSessionId();
    this.sessionFile = ctx.sessionManager.getSessionFile();
    const entries = deriveResultStateFromEntries(ctx.sessionManager.getEntries(), this.sessionId);
    this.pendingResults = entries.saved;
    this.latestResults = entries.latest;
    this.refreshActiveBranch();
    for (const result of takeFallbackResults(this.sessionId)) {
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
            resultSessionId: undefined,
            resultOriginEntryId: undefined,
          },
    );

    getNavigator()?.ensureTimer();

    const record = this.manager.getRecord(agentId)!;
    if (!runInBackground) {
      let resolveDetach: (() => void) | undefined;
      const detachPromise = new Promise<"detached">(resolve => {
        resolveDetach = () => resolve("detached");
      });
      record.execution.detach = resolveDetach;

      try {
        const outcome = await Promise.race([
          record.execution.promise
            ? record.execution.promise.then(() => "completed" as const).catch(() => "completed" as const)
            : Promise.resolve("completed" as const),
          detachPromise,
        ]);

        if (outcome === "detached") {
          if (!record.execution.resultSessionId) {
            record.execution.resultSessionId = ctx.sessionManager.getSessionId();
            record.execution.resultOriginEntryId = ctx.sessionManager.getLeafId();
            if (record.execution.resultOriginEntryId) {
              this.activeBranchIds.add(record.execution.resultOriginEntryId);
            }
          }
          return { agentId, record, detached: true };
        }

        record.lifecycle.resultConsumed = true;
      } finally {
        delete record.execution.detach;
      }
    }

    return { agentId, record };
  }

  /** Route user input to a running or settled subagent session. */
  async interact(agentId: string, message: string, images?: ImageContent[]): Promise<InteractionResult> {
    const record = this.manager.getRecord(agentId);
    if (!record) return { accepted: false, reason: "unavailable" };

    if (!record.execution.resultSessionId) {
      const ctx = getSessionCtx();
      record.execution.resultSessionId = ctx.sessionManager.getSessionId();
      record.execution.resultOriginEntryId = ctx.sessionManager.getLeafId();
      if (record.execution.resultOriginEntryId) {
        this.activeBranchIds.add(record.execution.resultOriginEntryId);
      }
    }

    const result = await this.manager.interact(agentId, message, images);
    if (result.accepted) getNavigator()?.ensureTimer();
    return result;
  }

  /** Cancel active auto-retry delay sleep for a running subagent. */
  abortRetry(agentId: string): boolean {
    return this.manager.abortRetry(agentId);
  }

  getDeliverableMessages(agentId: string): DeliverableMessage[] {
    const record = this.manager.getRecord(agentId);
    if (!record) return [];
    const sessionMessages = record.execution.session?.messages;
    if (sessionMessages && sessionMessages.length > 0) {
      const extracted = extractDeliverableMessages(sessionMessages);
      if (extracted.length > 0) return extracted;
    }
    if (record.result && record.result.trim()) {
      return [{ role: "assistant", content: record.result.trim() }];
    }
    return [];
  }

  deliverSelectedMessages(agentId: string, messageIndices: number[]): PendingResult | undefined {
    const record = this.manager.getRecord(agentId);
    if (!record || this.disposed) return undefined;

    if (!record.execution.resultSessionId) {
      const ctx = getSessionCtx();
      record.execution.resultSessionId = ctx.sessionManager.getSessionId();
      record.execution.resultOriginEntryId = ctx.sessionManager.getLeafId();
      if (record.execution.resultOriginEntryId) {
        this.activeBranchIds.add(record.execution.resultOriginEntryId);
      }
    }

    const deliverable = this.getDeliverableMessages(agentId);
    const selected = messageIndices.map(i => deliverable[i]).filter((m): m is DeliverableMessage => Boolean(m));
    if (selected.length === 0) return undefined;

    const formatted = formatSubagentDelivery({
      taskOrigin: record.display.description,
      type: record.display.type,
      messages: selected,
    });

    const deliveryId = randomUUID();
    const result: PendingResult = {
      deliveryId,
      parentSessionId: record.execution.resultSessionId,
      originEntryId: record.execution.resultOriginEntryId ?? null,
      agentId: record.id,
      type: record.display.type,
      status: record.lifecycle.status,
      result: formatted,
      error: null,
      provider: record.display.invocation?.providerName,
      model: record.display.invocation?.modelName,
      createdAt: Date.now(),
    };

    this.fallbackResults.set(result.deliveryId, result);
    record.execution.resultDeliveryId = result.deliveryId;
    this.flushFallbackResults();
    if (this.fallbackResults.has(result.deliveryId)) {
      getNavigator()?.update();
      return undefined;
    }
    this.requestParentWake();
    return result;
  }

  /** Persist a background completion and let that completion request a wake-up. */
  onAgentComplete(record: AgentRecord): void {
    // Manual clear and manager shutdown remove the record before the async run
    // settles. Those completions are intentionally discarded, not re-enqueued.
    if (!record.execution.resultSessionId || this.disposed || !this.manager.getRecord(record.id)) return;

    if (record.lifecycle.takenOver) {
      getNavigator()?.update();
      return;
    }

    const result = storedResult(record);
    if (!result) return;

    this.fallbackResults.set(result.deliveryId, result);
    record.execution.resultDeliveryId = result.deliveryId;
    const completionVersion = this.completionVersion;
    this.flushFallbackResults();
    if (this.fallbackResults.has(result.deliveryId)) {
      if (this.completionVersion > completionVersion) this.requestParentWake();
      getNavigator()?.update();
      return;
    }

    this.requestParentWake();
    getNavigator()?.update();
  }

  /** Inject pending results into a normal parent prompt. */
  async prepareBeforeAgentStart(): Promise<ReturnType<typeof buildResultMessage>> {
    if (!this.isActive()) return undefined;
    if (this.parentRunPhase === "preflight") {
      this.inFlightDeliveryIds.clear();
      this.parentWakeActive = false;
    }
    const version = ++this.lifecycleVersion;
    this.parentRunPhase = "preflight";
    if (!await this.reconcileDeliveryState() || !this.isActive() || version !== this.lifecycleVersion) return undefined;
    const results = this.eligiblePendingResults()
      .filter(result => !this.inFlightDeliveryIds.has(result.deliveryId));
    const message = buildResultMessage(results);
    if (!message) return undefined;

    this.parentWakeActive = true;
    this.parentWakeCompletionVersion = this.completionVersion;
    for (const result of results) {
      this.inFlightDeliveryIds.add(result.deliveryId);
    }
    return message;
  }

  /** Flush a completion that landed after preflight but before the run started. */
  onParentAgentStart(): void {
    if (!this.isActive()) return;
    this.lifecycleVersion++;
    this.parentRunPhase = "running";
    if (this.completionVersion > this.parentWakeCompletionVersion) {
      this.requestParentWake();
    }
  }

  /** Keep follow-ups out of the gap before Pi finishes its post-run work. */
  onParentAgentEnd(): void {
    this.parentRunPhase = "settling";
  }

  /** Finalize delivery after Pi has exhausted retries and queued continuations. */
  async onParentSettled(): Promise<void> {
    if (!this.isActive()) return;
    const version = ++this.lifecycleVersion;
    this.parentRunPhase = "settling";
    const reconciled = await this.reconcileDeliveryState();
    if (!this.isActive() || version !== this.lifecycleVersion) return;
    const hasNewCompletion = this.completionVersion > this.parentWakeCompletionVersion;
    this.parentWakeCompletionVersion = this.completionVersion;
    this.parentRunPhase = "idle";
    this.parentWakeActive = false;
    for (const id of this.inFlightDeliveryIds) {
      if (this.pendingResults.has(id) && !this.deliveredResultIds.has(id)) this.failedResultIds.add(id);
    }
    this.inFlightDeliveryIds.clear();

    if (reconciled && hasNewCompletion) {
      queueMicrotask(() => {
        if (!this.isActive() || version !== this.lifecycleVersion) return;
        if (this.eligiblePendingResults().length > 0) {
          this.requestParentWake();
        }
        getNavigator()?.update();
      });
    }
    getNavigator()?.update();
  }

  /** Re-arm eligible delivery after a session reload without resuming child sessions. */
  async restorePending(): Promise<void> {
    const version = this.lifecycleVersion;
    if (!await this.reconcileDeliveryState() || !this.isActive() || version !== this.lifecycleVersion) return;
    this.activateEligiblePending();
    getNavigator()?.update();
  }

  /** Refresh branch-local visibility after /tree navigation. */
  async onSessionTree(): Promise<void> {
    if (!this.isActive()) return;
    this.lifecycleVersion++;
    this.refreshActiveBranch();
    this.parentRunPhase = "idle";
    this.parentWakeActive = false;
    this.inFlightDeliveryIds.clear();
    this.parentWakeCompletionVersion = this.completionVersion;
    await this.restorePending();
  }

  /** Return only exceptional pending state; normal in-flight delivery stays hidden. */
  pendingResultCount(): number | undefined {
    const visible = this.pendingState()
      .filter(result => !this.inFlightDeliveryIds.has(result.deliveryId));
    if (visible.length === 0) return undefined;

    const hasFailedDelivery = visible.some(result =>
      this.failedResultIds.has(result.deliveryId)
      || this.fallbackResults.has(result.deliveryId)
    );
    return hasFailedDelivery ? visible.length : undefined;
  }

  /** Read the record's current completion, or the latest durable result after record cleanup. */
  getStoredResult(agentId: string): PendingResult | undefined {
    const deliveryId = this.manager.getRecord(agentId)?.execution.resultDeliveryId;
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

  /** Suppress concurrent automatic sends while a tool result is still in flight. */
  markResultPresented(deliveryId: string): void {
    this.flushFallbackResults();
    if (this.pendingResults.has(deliveryId)) {
      this.inFlightDeliveryIds.add(deliveryId);
    }
  }

  /** Dispose delivery state; parent session entries remain durable. */
  dispose(): void {
    // Give a stale runtime one final chance to persist results before the
    // composition root drops its in-memory fallback. There is no second store
    // to write after the parent session itself is being replaced.
    this.flushFallbackResults();
    // Keep unsuccessful fallbacks in the composition-root shell so an
    // in-process session reload can retry them with the new coordinator.
    setFallbackResults(this.sessionId, [...this.fallbackResults.values()]);
    this.disposed = true;
  }

  private isActive(): boolean {
    if (this.disposed) return false;
    const session = getSessionCtx()?.sessionManager;
    return session?.getSessionId() === this.sessionId && session.getSessionFile() === this.sessionFile;
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
    return result.parentSessionId === this.sessionId
      && (result.originEntryId === null || this.activeBranchIds.has(result.originEntryId));
  }

  private eligiblePendingResults(): PendingResult[] {
    return [...this.pendingResults.values()].filter(result =>
      this.belongsToActiveBranch(result) && !this.deliveredResultIds.has(result.deliveryId)
    );
  }

  private activateEligiblePending(): void {
    this.flushFallbackResults();
    if (this.eligiblePendingResults().length > 0) this.requestParentWake();
  }

  private flushFallbackResults(): void {
    if (!this.isActive()) return;
    const pi = getPiInstance();
    for (const [deliveryId, result] of this.fallbackResults) {
      if (!appendPendingResult(pi, result)) {
        this.failedResultIds.add(deliveryId);
        continue;
      }
      this.fallbackResults.delete(deliveryId);
      this.completionVersion++;
      if (this.reconcilingPromise) this.reconcileQueued = true;
      if (!this.acknowledgedResultIds.has(deliveryId)) this.pendingResults.set(deliveryId, result);
      const latest = this.latestResults.get(result.agentId);
      if (!latest || result.createdAt >= latest.createdAt) this.latestResults.set(result.agentId, result);
      const record = this.manager.getRecord(result.agentId);
      if (record?.execution.resultDeliveryId === deliveryId) record.lifecycle.resultPersisted = true;
    }
  }

  /**
   * Reconcile durable delivery state from the persisted session log.
   *
   * Verifies delivery receipts on disk (subagent-result messages and AgentStatus
   * tool results) and appends missing result-ack entries. ACK indicates that
   * the parent session has durably ingested the result into its context.
   */
  async reconcileDeliveryState(): Promise<boolean> {
    if (!this.isActive()) return false;
    if (this.reconcilingPromise) {
      this.reconcileQueued = true;
      return this.reconcilingPromise;
    }

    this.reconcilingPromise = (async () => {
      let reconciled = false;
      try {
        do {
          this.reconcileQueued = false;
          reconciled = await this.doReconcileDeliveryState();
        } while (this.reconcileQueued && this.isActive());
        return reconciled;
      } finally {
        this.reconcilingPromise = null;
      }
    })();
    return this.reconcilingPromise;
  }

  private async doReconcileDeliveryState(): Promise<boolean> {
    if (!this.isActive()) return false;
    this.flushFallbackResults();
    const pendingAtRead = new Map(this.pendingResults);
    const durable = await readDurableLogState(this.sessionFile, this.sessionId);
    if (!durable || !this.isActive()) return false;

    // A failed Pi append can leave an entry in its memory view. Preserve the
    // payload for a later append, without treating it as safely persisted.
    for (const [id, result] of pendingAtRead) {
      if (durable.saved.has(id)) continue;
      this.pendingResults.delete(id);
      this.fallbackResults.set(id, result);
      const record = this.manager.getRecord(result.agentId);
      if (record?.execution.resultDeliveryId === id) record.lifecycle.resultPersisted = false;
    }
    for (const [id, result] of durable.saved) {
      this.fallbackResults.delete(id);
      if (!this.acknowledgedResultIds.has(id)) this.pendingResults.set(id, result);
      const record = this.manager.getRecord(result.agentId);
      if (record?.execution.resultDeliveryId === id) record.lifecycle.resultPersisted = true;
    }
    for (const id of durable.acknowledgedIds) {
      this.acknowledgedResultIds.add(id);
      this.pendingResults.delete(id);
      this.failedResultIds.delete(id);
      const result = durable.saved.get(id);
      const record = result ? this.manager.getRecord(result.agentId) : undefined;
      if (record?.execution.resultDeliveryId === id) record.lifecycle.resultConsumed = true;
    }
    for (const id of durable.deliveredIds) this.deliveredResultIds.add(id);

    const toAck = [...durable.deliveredIds].filter(id => !this.acknowledgedResultIds.has(id));
    if (toAck.length > 0) this.acknowledge(toAck);

    for (const [agentId, result] of durable.latest) {
      const current = this.latestResults.get(agentId);
      if (!current || result.createdAt >= current.createdAt) {
        this.latestResults.set(agentId, result);
      }
    }
    for (const id of [...this.inFlightDeliveryIds]) {
      if (this.deliveredResultIds.has(id) || this.acknowledgedResultIds.has(id)) {
        this.inFlightDeliveryIds.delete(id);
      }
    }

    getNavigator()?.update();
    return true;
  }

  /** One idempotent wake request; later completions only add to the session inbox. */
  private requestParentWake(): void {
    if (
      !this.isActive()
      || this.parentWakeActive
      || this.parentRunPhase === "preflight"
      || this.parentRunPhase === "settling"
    ) return;
    if (this.reconcilingPromise) {
      void this.reconcilingPromise.then(reconciled => {
        if (reconciled) this.requestParentWake();
      });
      return;
    }
    this.flushFallbackResults();
    const pi = getPiInstance();
    const pending = this.eligiblePendingResults()
      .filter(result => !this.inFlightDeliveryIds.has(result.deliveryId));
    const message = buildResultMessage(pending);
    if (!message) return;

    this.parentWakeActive = true;
    this.parentWakeCompletionVersion = this.completionVersion;
    for (const result of pending) {
      this.inFlightDeliveryIds.add(result.deliveryId);
    }

    try {
      if (this.parentRunPhase === "running" || !getSessionCtx().isIdle()) {
        pi.sendMessage(message, { deliverAs: "followUp" });
      } else {
        pi.sendMessage(message, { triggerTurn: true });
      }
    } catch {
      this.parentWakeActive = false;
      for (const result of pending) {
        this.inFlightDeliveryIds.delete(result.deliveryId);
        this.failedResultIds.add(result.deliveryId);
      }
      getNavigator()?.update();
    }
  }

  private acknowledge(ids: readonly string[]): boolean {
    const pi = getPiInstance();
    if (!appendResultAck(pi, this.sessionId, ids)) {
      for (const deliveryId of ids) this.failedResultIds.add(deliveryId);
      return false;
    }
    for (const deliveryId of ids) {
      const result = this.pendingResults.get(deliveryId);
      this.pendingResults.delete(deliveryId);
      this.acknowledgedResultIds.add(deliveryId);
      this.inFlightDeliveryIds.delete(deliveryId);
      this.failedResultIds.delete(deliveryId);
      const agentId = result?.agentId;
      const record = agentId ? this.manager.getRecord(agentId) : undefined;
      if (record?.execution.resultDeliveryId === deliveryId) record.lifecycle.resultConsumed = true;
    }
    return true;
  }
}
