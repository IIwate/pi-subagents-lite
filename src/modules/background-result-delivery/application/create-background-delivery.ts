import { Check } from "typebox/value";
import {
  BackgroundResultRecordSchema,
  DeliveryCommandResultSchema,
  DeliveryCommandSchema,
  type BackgroundResultRecord,
  type DeliveryCommand,
  type DeliveryCommandResult,
  type DeliveryEvent,
  type DeliverySnapshot,
  type ParentPhase,
} from "../contracts/delivery.js";
import { belongsToActiveBranch, buildResultMessage } from "../core/eligibility.js";
import type {
  DeliveryFallbackStore,
  DeliveryHostContext,
  ParentMessenger,
  ResultRepository,
} from "../ports/delivery-ports.js";

export interface CreateBackgroundDeliveryOptions {
  repository: ResultRepository;
  messenger: ParentMessenger;
  context: DeliveryHostContext;
  fallback: DeliveryFallbackStore;
}

export interface BackgroundDelivery {
  execute(command: unknown): DeliveryCommandResult;
  pendingResultCount(): number | undefined;
  getStoredResult(agentId: string, deliveryId?: string): BackgroundResultRecord | undefined;
}

function failure(
  code: Extract<DeliveryCommandResult, { ok: false }>["error"]["code"],
  message: string,
): DeliveryCommandResult {
  return { ok: false, error: { code, message } };
}

/**
 * The last door a result walks through. Pending maps and host callbacks can
 * hold a record that was valid when it arrived and is not valid now — a status
 * overwritten in place, a session id that stopped being a string. Wake and
 * inspect treat a successful result as a complete picture, so a half-valid
 * snapshot is how one bad field becomes a parent message. invalid-command is
 * the only failure this schema names; a dedicated contract code would be worth
 * adding if callers ever needed to tell inbound garbage from a broken view.
 */
function outbound(result: DeliveryCommandResult): DeliveryCommandResult {
  return Check(DeliveryCommandResultSchema, result)
    ? result
    : failure("invalid-command", "Delivery result does not match its contract.");
}

/**
 * Records restored from a parent session or the process inbox are the oldest
 * data this module handles: written by an earlier version, hand-editable, and
 * outside this process's control. A record that no longer matches the contract
 * is skipped rather than repaired — a repaired record would carry an invented
 * delivery target or status into a wake message. The remaining results still
 * reach the parent, which matters more than an all-or-nothing restore.
 */
function inbound(records: readonly BackgroundResultRecord[]): BackgroundResultRecord[] {
  return records.filter((record) => Check(BackgroundResultRecordSchema, record));
}

export function createBackgroundDelivery(options: CreateBackgroundDeliveryOptions): BackgroundDelivery {
  let parentRunPhase: ParentPhase = "idle";
  let parentWakeActive = false;
  let parentTurnResultIds = new Set<string>();
  let completionVersion = 0;
  let parentWakeCompletionVersion = 0;
  let parentRunSucceeded = true;
  let lastWakeFailed = false;
  const failedResultIds = new Set<string>();
  const entries = options.repository.read();
  const pendingResults = new Map(inbound(entries.pending).map((result) => [result.deliveryId, result]));
  const latestResults = new Map(inbound(entries.latest).map((result) => [result.agentId, result]));
  let activeBranchIds = new Set(options.context.activeBranchIds());
  const fallbackResults = new Map(
    inbound(options.fallback.take(options.context.parentSessionId()))
      .map((result) => [result.deliveryId, result]),
  );
  let disposed = false;
  let events: DeliveryEvent[] = [];

  function emit(event: DeliveryEvent): void {
    events.push(event);
  }

  function snapshot(): DeliverySnapshot {
    const visible = pendingState().filter((result) => !parentTurnResultIds.has(result.deliveryId));
    const hasFailed = visible.some((result) =>
      failedResultIds.has(result.deliveryId) || fallbackResults.has(result.deliveryId),
    );
    return {
      parentSessionId: options.context.parentSessionId(),
      parentRunPhase,
      parentWakeActive,
      lastWakeFailed,
      pending: [...pendingResults.values()],
      fallback: [...fallbackResults.values()],
      visiblePendingCount: visible.length > 0 && hasFailed ? visible.length : undefined,
    };
  }

  function ok(extra: Partial<Extract<DeliveryCommandResult, { ok: true }>> = {}): DeliveryCommandResult {
    return { ok: true, snapshot: snapshot(), events, ...extra };
  }

  function pendingState(): BackgroundResultRecord[] {
    return [...pendingResults.values(), ...fallbackResults.values()]
      .filter((result) => belongsToActiveBranch(result, options.context.parentSessionId(), activeBranchIds));
  }

  function eligiblePendingResults(): BackgroundResultRecord[] {
    return [...pendingResults.values()]
      .filter((result) => belongsToActiveBranch(result, options.context.parentSessionId(), activeBranchIds));
  }

  function refreshActiveBranch(): void {
    activeBranchIds = new Set(options.context.activeBranchIds());
  }

  function flushFallbackResults(): void {
    for (const [deliveryId, result] of fallbackResults) {
      if (!options.repository.append(result)) {
        failedResultIds.add(deliveryId);
        continue;
      }
      fallbackResults.delete(deliveryId);
      completionVersion += 1;
      pendingResults.set(deliveryId, result);
      const latest = latestResults.get(result.agentId);
      if (!latest || result.createdAt >= latest.createdAt) latestResults.set(result.agentId, result);
      emit({ type: "persisted", deliveryId });
    }
  }

  function requestParentWake(): void {
    if (
      disposed
      || parentWakeActive
      || parentRunPhase === "preflight"
      || parentRunPhase === "settling"
    ) return;
    flushFallbackResults();
    const pending = eligiblePendingResults();
    const message = buildResultMessage(pending);
    if (!message) return;
    const previousTurnIds = parentTurnResultIds;
    const previousRunSucceeded = parentRunSucceeded;
    parentWakeActive = true;
    parentWakeCompletionVersion = completionVersion;
    parentRunSucceeded = false;
    parentTurnResultIds = new Set([
      ...previousTurnIds,
      ...pending.map((result) => result.deliveryId),
    ]);
    lastWakeFailed = false;
    const mode = parentRunPhase === "running" || !options.context.isIdle() ? "follow-up" : "turn";
    const deliveryIds = pending.map((result) => result.deliveryId);
    if (options.messenger.send(message, mode)) {
      emit({ type: "wake-requested", deliveryIds, mode });
      return;
    }
    parentWakeActive = false;
    parentRunSucceeded = previousRunSucceeded;
    parentTurnResultIds = previousTurnIds;
    for (const result of pending) failedResultIds.add(result.deliveryId);
    lastWakeFailed = true;
    emit({ type: "wake-failed", deliveryIds });
  }

  function acknowledge(ids: readonly string[]): boolean {
    if (!options.repository.acknowledge(options.context.parentSessionId(), ids)) {
      for (const deliveryId of ids) failedResultIds.add(deliveryId);
      lastWakeFailed = true;
      return false;
    }
    for (const deliveryId of ids) {
      pendingResults.delete(deliveryId);
      failedResultIds.delete(deliveryId);
    }
    emit({ type: "acknowledged", deliveryIds: [...ids] });
    return true;
  }

  function recordTerminal(record: BackgroundResultRecord, stillPresent: boolean): DeliveryCommandResult {
    if (!stillPresent || disposed) return ok();
    fallbackResults.set(record.deliveryId, record);
    const version = completionVersion;
    flushFallbackResults();
    if (fallbackResults.has(record.deliveryId)) {
      emit({ type: "fallback-retained", deliveryId: record.deliveryId });
      lastWakeFailed = true;
      if (completionVersion > version) requestParentWake();
      return ok();
    }
    lastWakeFailed = false;
    if (!belongsToActiveBranch(record, options.context.parentSessionId(), activeBranchIds)) {
      emit({ type: "hidden", deliveryId: record.deliveryId });
      return ok();
    }
    requestParentWake();
    return ok();
  }

  function parentSettled(): DeliveryCommandResult {
    if (disposed) return ok();
    const ids = [...parentTurnResultIds];
    const succeeded = parentRunSucceeded;
    const deliveryFailed = lastWakeFailed;
    const hasNewCompletion = completionVersion > parentWakeCompletionVersion;
    const hasPending = eligiblePendingResults().length > 0;
    const hasNewWakeOpportunity = hasNewCompletion && hasPending;
    parentRunPhase = "idle";
    parentWakeActive = false;
    parentTurnResultIds.clear();

    let wakeAfterSettle = false;
    if (succeeded) {
      lastWakeFailed = false;
      const acknowledged = ids.length === 0 || acknowledge(ids);
      lastWakeFailed ||= deliveryFailed && pendingState().length > 0;
      wakeAfterSettle = (!deliveryFailed && acknowledged) || hasNewWakeOpportunity;
    } else {
      lastWakeFailed = true;
      for (const deliveryId of ids) {
        if (pendingResults.has(deliveryId)) failedResultIds.add(deliveryId);
      }
      wakeAfterSettle = hasNewWakeOpportunity;
    }
    if (wakeAfterSettle) requestParentWake();
    return ok();
  }

  return {
    execute(command: unknown): DeliveryCommandResult {
      events = [];
      return outbound(run(command));
    },
    pendingResultCount() {
      return snapshot().visiblePendingCount;
    },
    getStoredResult(agentId, deliveryId) {
      return getStored(agentId, deliveryId);
    },
  };

  function run(command: unknown): DeliveryCommandResult {
    if (!Check(DeliveryCommandSchema, command)) {
      return failure("invalid-command", "Delivery command is invalid.");
    }
    const next = command as DeliveryCommand;
    switch (next.kind) {
      case "record-terminal":
        return recordTerminal(next.record, next.stillPresent);
      case "track-origin":
        // Dropped by the next refresh on purpose: by then the host reports
        // the entry itself, or the user navigated away and the result no
        // longer belongs to the visible branch.
        if (!disposed) activeBranchIds.add(next.originEntryId);
        return ok();
      case "parent-preflight": {
        if (disposed) return ok();
        refreshActiveBranch();
        parentRunPhase = "preflight";
        flushFallbackResults();
        const results = eligiblePendingResults();
        const injection = buildResultMessage(results);
        if (!injection) return ok();
        parentWakeActive = true;
        parentWakeCompletionVersion = completionVersion;
        parentRunSucceeded = false;
        parentTurnResultIds = new Set(results.map((result) => result.deliveryId));
        lastWakeFailed = false;
        emit({ type: "injected", deliveryIds: results.map((result) => result.deliveryId) });
        return ok({ injection });
      }
      case "parent-start":
        if (!disposed) {
          parentRunPhase = "running";
          requestParentWake();
        }
        return ok();
      case "parent-end":
        parentRunPhase = "settling";
        parentRunSucceeded = next.succeeded;
        return ok();
      case "parent-settled":
        return parentSettled();
      case "restore":
        if (!disposed) {
          refreshActiveBranch();
          flushFallbackResults();
          const restored = eligiblePendingResults();
          if (restored.length > 0) {
            emit({ type: "restored", deliveryIds: restored.map((result) => result.deliveryId) });
            requestParentWake();
          }
        }
        return ok();
      case "session-tree":
        if (!disposed) {
          refreshActiveBranch();
          parentRunPhase = "idle";
          parentWakeActive = false;
          parentTurnResultIds.clear();
          parentWakeCompletionVersion = completionVersion;
          lastWakeFailed = false;
          flushFallbackResults();
          const restored = eligiblePendingResults();
          if (restored.length > 0) {
            emit({ type: "restored", deliveryIds: restored.map((result) => result.deliveryId) });
            requestParentWake();
          }
        }
        return ok();
      case "mark-presented":
        flushFallbackResults();
        if (pendingResults.has(next.deliveryId)) parentTurnResultIds.add(next.deliveryId);
        return ok();
      case "inspect":
        return next.agentId
          ? ok({ stored: getStored(next.agentId, next.deliveryId) })
          : ok();
      case "dispose":
        flushFallbackResults();
        options.fallback.save(options.context.parentSessionId(), [...fallbackResults.values()]);
        disposed = true;
        return ok();
    }
  }

  function getStored(agentId: string, deliveryId?: string): BackgroundResultRecord | undefined {
    if (deliveryId) {
      const latest = latestResults.get(agentId);
      return fallbackResults.get(deliveryId)
        ?? pendingResults.get(deliveryId)
        ?? (latest?.deliveryId === deliveryId ? latest : undefined);
    }
    const latest = latestResults.get(agentId);
    const fallback = [...fallbackResults.values()]
      .filter((result) => result.agentId === agentId)
      .reduce<BackgroundResultRecord | undefined>(
        (newest, result) => !newest || result.createdAt >= newest.createdAt ? result : newest,
        undefined,
      );
    if (!fallback) return latest;
    // Same-millisecond continuations share createdAt. Treating equality as
    // "fallback is newer" would resurrect the failed persist over the
    // completion that just landed. Prefer the persisted latest on a tie.
    if (!latest || fallback.createdAt > latest.createdAt) return fallback;
    return latest;
  }
}
