import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  BackgroundResultRecord,
  ResultRepository,
} from "../../modules/background-result-delivery/public.js";
import { Check } from "typebox/value";
import { BackgroundResultRecordSchema } from "../../modules/background-result-delivery/public.js";

export const PENDING_RESULT_ENTRY = "subagents-lite:pending-result";
export const RESULT_ACK_ENTRY = "subagents-lite:result-ack";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parsePendingResult(data: unknown): BackgroundResultRecord | undefined {
  if (!isRecord(data)) return undefined;
  const normalized = {
    ...data,
    error: data.error === "" ? null : data.error,
  };
  if (!Check(BackgroundResultRecordSchema, normalized)) return undefined;
  return normalized;
}

function parseAck(data: unknown): { parentSessionId: string; deliveryIds: string[] } | undefined {
  if (!isRecord(data) || !Array.isArray(data.deliveryIds)) return undefined;
  const parentSessionId = stringValue(data.parentSessionId);
  if (!parentSessionId) return undefined;
  return {
    parentSessionId,
    deliveryIds: data.deliveryIds.filter((id): id is string => typeof id === "string" && id.length > 0),
  };
}

/**
 * Empty persisted errors used to ride along as missing text. Treating "" as
 * null keeps the durable record; rejecting it would drop a finished Agent
 * because one field arrived hollow. Revisit if the schema starts
 * distinguishing "no error" from "error text unknown".
 */
function readResultEntries(
  ctx: ExtensionContext,
): { pending: BackgroundResultRecord[]; latest: BackgroundResultRecord[] } {
  const latest = new Map<string, BackgroundResultRecord>();
  const pending = new Map<string, BackgroundResultRecord>();
  const parentSessionId = ctx.sessionManager.getSessionId();

  for (const entry of ctx.sessionManager.getEntries()) {
    if (!isRecord(entry) || entry.type !== "custom") continue;
    if (entry.customType === PENDING_RESULT_ENTRY) {
      const result = parsePendingResult(entry.data);
      if (!result || result.parentSessionId !== parentSessionId) continue;
      const currentLatest = latest.get(result.agentId);
      if (!currentLatest || result.createdAt >= currentLatest.createdAt) latest.set(result.agentId, result);
      pending.set(result.deliveryId, result);
      continue;
    }
    if (entry.customType === RESULT_ACK_ENTRY) {
      const ack = parseAck(entry.data);
      if (!ack || ack.parentSessionId !== parentSessionId) continue;
      for (const deliveryId of ack.deliveryIds) pending.delete(deliveryId);
    }
  }

  return { pending: [...pending.values()], latest: [...latest.values()] };
}

export function createPiResultRepository(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): ResultRepository {
  return {
    read() {
      return readResultEntries(ctx);
    },
    append(record) {
      try {
        pi.appendEntry(PENDING_RESULT_ENTRY, record);
        return true;
      } catch {
        return false;
      }
    },
    acknowledge(parentSessionId, deliveryIds) {
      try {
        pi.appendEntry(RESULT_ACK_ENTRY, { parentSessionId, deliveryIds: [...deliveryIds] });
        return true;
      } catch {
        return false;
      }
    },
  };
}
