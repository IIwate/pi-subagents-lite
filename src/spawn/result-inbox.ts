import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentStatus, BackgroundDeliveryMode } from "../types.js";

export const PENDING_RESULT_ENTRY = "subagents-lite:pending-result";
export const RESULT_ACK_ENTRY = "subagents-lite:result-ack";
export const RESULT_MESSAGE_TYPE = "subagent-result";

export interface PendingResult {
  /** Unique completion identity. A continuation gets a new deliveryId. */
  deliveryId: string;
  /** Results never cross a new/forked parent session. */
  parentSessionId: string;
  /** Result is eligible only while this entry remains on the active branch. */
  originEntryId: string | null;
  agentId: string;
  type: string;
  status: AgentStatus;
  result: string;
  error: string | null;
  provider?: string;
  model?: string;
  createdAt: number;
  delivery: BackgroundDeliveryMode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validStatus(value: unknown): value is AgentStatus {
  return value === "queued"
    || value === "running"
    || value === "completed"
    || value === "turn_limited"
    || value === "aborted"
    || value === "stopped"
    || value === "error";
}

function validDelivery(value: unknown): value is BackgroundDeliveryMode {
  return value === "auto" || value === "next-turn";
}

function parsePendingResult(data: unknown): PendingResult | undefined {
  if (!isRecord(data)) return undefined;
  const deliveryId = stringValue(data.deliveryId);
  const parentSessionId = stringValue(data.parentSessionId);
  const originEntryId = data.originEntryId === null ? null : stringValue(data.originEntryId);
  const agentId = stringValue(data.agentId);
  const type = stringValue(data.type);
  const result = stringValue(data.result);
  const error = data.error === null || data.error === "" ? null : stringValue(data.error);
  if (
    !deliveryId
    || !parentSessionId
    || originEntryId === undefined
    || !agentId
    || !type
    || !result
    || error === undefined
    || !validStatus(data.status)
    || !validDelivery(data.delivery)
    || typeof data.createdAt !== "number"
  ) return undefined;
  return {
    deliveryId,
    parentSessionId,
    originEntryId,
    agentId,
    type,
    status: data.status,
    result,
    error,
    provider: stringValue(data.provider),
    model: stringValue(data.model),
    createdAt: data.createdAt,
    delivery: data.delivery,
  };
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

/** Read this session's latest result data and currently unacknowledged subset. */
export function readResultEntries(ctx: ExtensionContext): {
  latest: Map<string, PendingResult>;
  pending: Map<string, PendingResult>;
} {
  const latest = new Map<string, PendingResult>();
  const pending = new Map<string, PendingResult>();
  const parentSessionId = ctx.sessionManager.getSessionId();

  for (const entry of ctx.sessionManager.getEntries()) {
    if (!isRecord(entry) || entry.type !== "custom") continue;
    if (entry.customType === PENDING_RESULT_ENTRY) {
      const result = parsePendingResult(entry.data);
      if (!result || result.parentSessionId !== parentSessionId) continue;
      latest.set(result.agentId, result);
      pending.set(result.deliveryId, result);
      continue;
    }
    if (entry.customType === RESULT_ACK_ENTRY) {
      const ack = parseAck(entry.data);
      if (!ack || ack.parentSessionId !== parentSessionId) continue;
      for (const deliveryId of ack.deliveryIds) pending.delete(deliveryId);
    }
  }

  return { latest, pending };
}

/** Persist one completed result in the parent session without adding it to LLM context. */
export function appendPendingResult(pi: ExtensionAPI, result: PendingResult): boolean {
  try {
    pi.appendEntry(PENDING_RESULT_ENTRY, result);
    return true;
  } catch {
    return false;
  }
}

/** Persist an acknowledgement after a parent turn successfully received result IDs. */
export function appendResultAck(
  pi: ExtensionAPI,
  parentSessionId: string,
  deliveryIds: readonly string[],
): boolean {
  try {
    pi.appendEntry(RESULT_ACK_ENTRY, { parentSessionId, deliveryIds: [...deliveryIds] });
    return true;
  } catch {
    return false;
  }
}

function buildResultContent(results: readonly PendingResult[]): string {
  return results.map(result =>
    `[Subagent "${result.type}" ${result.agentId} ${result.status}]\n\n${result.result}`,
  ).join("\n\n---\n\n");
}

export function buildResultMessage(results: readonly PendingResult[]) {
  if (results.length === 0) return undefined;
  return {
    customType: RESULT_MESSAGE_TYPE,
    content: buildResultContent(results),
    display: false as const,
  };
}

export function findStoredResult(ctx: ExtensionContext, agentId: string): PendingResult | undefined {
  return readResultEntries(ctx).latest.get(agentId);
}
