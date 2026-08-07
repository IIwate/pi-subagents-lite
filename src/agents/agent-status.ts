/**
 * AgentStatus tool implementation.
 *
 * The no-argument form lists current records. An exact agent_id also searches
 * the parent session's durable result entries.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../types.js";
import { getCoordinator, getManager } from "../shell.js";
import { findStoredResult } from "../spawn/result-inbox.js";
import { formatResultContent } from "./tool-execution.js";

function formatAgent(record: AgentRecord): string {
  return `${record.id} (${record.display.type}) ${record.lifecycle.status}`;
}

function modelProvider(record: AgentRecord): { provider?: string; model?: string } {
  const sessionModel = record.execution.session?.model;
  return {
    provider: sessionModel?.provider ?? record.display.invocation?.providerName,
    model: sessionModel?.id ?? record.display.invocation?.modelName,
  };
}

function resultLookupText(
  agentId: string,
  record: AgentRecord | undefined,
  stored: ReturnType<typeof findStoredResult>,
): string | undefined {
  if (!record && !stored) return undefined;

  const status = record?.lifecycle.status ?? stored!.status;
  const error = record?.error ?? stored?.error;
  const recordResult = record?.result?.trim() ?? "";
  const result = recordResult || stored?.result || (record ? formatResultContent(record).trim() : "");
  const recordModel = record ? modelProvider(record) : {};
  const provider = recordModel.provider ?? stored?.provider;
  const model = recordModel.model ?? stored?.model;

  const lines = [
    `Agent ${agentId}: ${status}`,
    `Provider: ${provider ?? "unknown"}`,
    `Model: ${model ?? "unknown"}`,
  ];
  if (error) lines.push(`Error: ${error}`);
  if (result) lines.push(`Result:\n${result}`);
  return lines.join("\n");
}

/** Execute AgentStatus without polling or sleep-waiting. */
export async function executeAgentStatusTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  _ctx: ExtensionContext,
): Promise<any> {
  const manager = getManager()!;
  const requestedId = typeof params.agent_id === "string" ? params.agent_id.trim() : "";
  const nudge = "Don't poll, sleep, or timeout-wait — background results are delivered automatically.";

  if (requestedId) {
    const record = manager.getRecord(requestedId);
    const coordinator = getCoordinator();
    const stored = coordinator?.getStoredResult(requestedId)
      ?? (record?.result ? undefined : findStoredResult(_ctx, requestedId));
    const text = resultLookupText(requestedId, record, stored);
    if (!text) {
      return {
        content: [{ type: "text", text: `Unknown agent: ${requestedId}\n\n${nudge}` }],
        isError: true,
      };
    }

    if (stored) coordinator?.markResultPresented(stored.deliveryId);
    return { content: [{ type: "text", text: `${text}\n\n${nudge}` }] };
  }

  const agents = manager.listAgents();
  if (agents.length === 0) {
    return {
      content: [{ type: "text", text: `No agents running or completed.\n\n${nudge}` }],
    };
  }

  const formatted = agents.map(formatAgent).join(", ");
  return {
    content: [{ type: "text", text: `${formatted}\n\n${nudge}` }],
  };
}
