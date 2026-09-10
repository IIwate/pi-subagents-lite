/**
 * result-inbox.ts — Session-local durable storage and receipt tracking for background agent results.
 */

import { readFile } from "node:fs/promises";
import { parseSessionEntries, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentStatus } from "../types.js";

export const PENDING_RESULT_ENTRY = "subagents-lite:pending-result";
export const RESULT_ACK_ENTRY = "subagents-lite:result-ack";
export const RESULT_MESSAGE_TYPE = "subagent-result";
export const PARENT_INJECTION_RESULT_CHAR_LIMIT = 4000;

export interface DeliveryReceiptMetadata {
  parentSessionId: string;
  deliveryIds: string[];
}

export interface ResultInboxState {
  saved: Map<string, PendingResult>;
  deliveredIds: Set<string>;
  acknowledgedIds: Set<string>;
  latest: Map<string, PendingResult>;
}

// Note: see .agents/notes/implemented/architecture/2026-09-09-parent-result-delivery-and-ack.md
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
    || typeof data.createdAt !== "number"
    || !Number.isFinite(data.createdAt)
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

export function getDeliveryReceipt(message: unknown): DeliveryReceiptMetadata | undefined {
  if (!isRecord(message)) return undefined;
  const isAutomatic = message.role === "custom"
    && message.customType === RESULT_MESSAGE_TYPE
    && message.display === false;
  const isLookup = message.role === "toolResult"
    && message.toolName === "AgentStatus"
    && !!stringValue(message.toolCallId)
    && message.isError === false;
  if (!isAutomatic && !isLookup) return undefined;
  const hasContent = typeof message.content === "string"
    ? message.content.trim().length > 0
    : Array.isArray(message.content) && message.content.some(part =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0
    );
  if (!hasContent || !isRecord(message.details)) return undefined;
  const { parentSessionId, deliveryIds } = message.details;
  if (!stringValue(parentSessionId) || !Array.isArray(deliveryIds) || deliveryIds.length === 0
    || !deliveryIds.every(id => typeof id === "string" && id.length > 0)) return undefined;
  return { parentSessionId: parentSessionId as string, deliveryIds: [...new Set(deliveryIds)] };
}

/** Derive saved, delivered, and acknowledged result sets from raw session entries. */
export function deriveResultStateFromEntries(
  entries: readonly unknown[],
  parentSessionId: string,
): ResultInboxState {
  const saved = new Map<string, PendingResult>();
  const deliveredIds = new Set<string>();
  const acknowledgedIds = new Set<string>();
  const latest = new Map<string, PendingResult>();

  for (const entry of entries) {
    if (!isRecord(entry)) continue;

    if (entry.type === "custom" && entry.customType === PENDING_RESULT_ENTRY) {
      const result = parsePendingResult(entry.data);
      if (!result || result.parentSessionId !== parentSessionId) continue;
      saved.set(result.deliveryId, result);
      const currentLatest = latest.get(result.agentId);
      if (!currentLatest || result.createdAt >= currentLatest.createdAt) {
        latest.set(result.agentId, result);
      }
      continue;
    }

    if (entry.type === "custom" && entry.customType === RESULT_ACK_ENTRY) {
      const ack = parseAck(entry.data);
      if (!ack || ack.parentSessionId !== parentSessionId) continue;
      for (const id of ack.deliveryIds) {
        acknowledgedIds.add(id);
      }
      continue;
    }

    if (!stringValue(entry.id) || !stringValue(entry.timestamp)
      || (entry.parentId !== null && !stringValue(entry.parentId))) continue;
    const receipt = entry.type === "custom_message"
      ? getDeliveryReceipt({ ...entry, role: "custom" })
      : entry.type === "message" && isRecord(entry.message) && entry.message.role === "toolResult"
        ? getDeliveryReceipt(entry.message)
        : undefined;
    if (receipt?.parentSessionId === parentSessionId) {
      for (const id of receipt.deliveryIds) deliveredIds.add(id);
    }
  }

  for (const id of deliveredIds) {
    if (!saved.has(id)) deliveredIds.delete(id);
  }
  return { saved, deliveredIds, acknowledgedIds, latest };
}

/** Read session entries directly from the persisted JSONL file on disk. */
export async function readDurableLogState(
  sessionFile: string | undefined,
  parentSessionId: string,
): Promise<ResultInboxState | undefined> {
  if (!sessionFile) return undefined;
  try {
    const content = await readFile(sessionFile, "utf-8");
    // Appending an ACK after a partial line would corrupt both records.
    if (!content.endsWith("\n")) return undefined;
    const entries = parseSessionEntries(content);
    const header = entries[0];
    if (!isRecord(header) || header.type !== "session" || header.id !== parentSessionId) return undefined;
    return deriveResultStateFromEntries(entries, parentSessionId);
  } catch {
    return undefined;
  }
}

/** Read this session's latest result data and currently unacknowledged subset. */
export function readResultEntries(ctx: ExtensionContext): {
  latest: Map<string, PendingResult>;
  pending: Map<string, PendingResult>;
} {
  const parentSessionId = ctx.sessionManager.getSessionId();
  const state = deriveResultStateFromEntries(ctx.sessionManager.getEntries(), parentSessionId);
  const pending = new Map<string, PendingResult>();

  for (const [id, result] of state.saved) {
    if (!state.acknowledgedIds.has(id)) {
      pending.set(id, result);
    }
  }

  return { latest: state.latest, pending };
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

/** Persist an acknowledgement for result IDs with verified durable receipts. */
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
  return results.map(result => {
    const text = result.result.length > PARENT_INJECTION_RESULT_CHAR_LIMIT
      ? result.result.slice(0, PARENT_INJECTION_RESULT_CHAR_LIMIT)
        + `\n… (truncated; use AgentStatus({ agent_id: "${result.agentId}" }) to read the full result)`
      : result.result;
    return `[Subagent "${result.type}" ${result.agentId} ${result.status}]\n\n${text}`;
  }).join("\n\n---\n\n");
}

export function buildResultMessage(results: readonly PendingResult[]) {
  if (results.length === 0) return undefined;
  const parentSessionId = results[0].parentSessionId;
  const deliveryIds = results.map(r => r.deliveryId);
  return {
    customType: RESULT_MESSAGE_TYPE,
    content: buildResultContent(results),
    display: false as const,
    details: {
      parentSessionId,
      deliveryIds,
    } satisfies DeliveryReceiptMetadata,
  };
}

export function findStoredResult(ctx: ExtensionContext, agentId: string): PendingResult | undefined {
  return readResultEntries(ctx).latest.get(agentId);
}
