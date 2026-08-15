/**
 * AgentStatus tool implementation.
 *
 * The no-argument form lists current records. An exact agent_id also searches
 * the parent session's durable result entries.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentListSnapshot, AgentSnapshot } from "../modules/subagent-runtime/public.js";
import type { BackgroundResultRecord } from "../modules/background-result-delivery/public.js";
import type { ExtensionRuntime } from "./extension-runtime.js";
import { formatResultContent } from "./agent-tool.js";

function formatAgent(record: AgentListSnapshot): string {
  return `${record.id} (${record.type}) ${record.status}`;
}

function modelProvider(record: AgentSnapshot): { provider?: string; model?: string } {
  return {
    provider: record.invocation?.providerName,
    model: record.invocation?.modelName,
  };
}

function resultLookupText(
  agentId: string,
  record: AgentSnapshot | undefined,
  stored: BackgroundResultRecord | undefined,
): string | undefined {
  if (!record && !stored) return undefined;

  const status = record?.status ?? stored!.status;
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

/** Bind the AgentStatus tool execute callback to the composition-root runtime. */
export function createAgentStatusToolExecutor(runtime: ExtensionRuntime) {
  /** Execute AgentStatus without polling or sleep-waiting. */
  return async (
    _toolCallId: string,
    params: Record<string, unknown>,
    _signal: AbortSignal | undefined,
    _onUpdate: ((update: any) => void) | undefined,
    _ctx: ExtensionContext,
  ): Promise<any> => {
    // Tools only execute inside a session, after session_start created the manager.
    const manager = runtime.manager!;
    const requestedId = typeof params.agent_id === "string" ? params.agent_id.trim() : "";
    const nudge = "Don't poll, sleep, or timeout-wait — background results are delivered automatically.";

    if (requestedId) {
      const record = manager.getSnapshot(requestedId);
      const delivery = runtime.delivery;
      // The schema command rereads durable session entries. A volatile record
      // may be gone while a later runtime has already written the full result.
      const inspected = delivery?.execute({
        kind: "inspect",
        agentId: requestedId,
        ...(record?.resultDeliveryId ? { deliveryId: record.resultDeliveryId } : {}),
      });
      const stored = inspected?.ok ? inspected.stored : undefined;
      const text = resultLookupText(requestedId, record, stored);
      if (!text) {
        return {
          content: [{ type: "text", text: `Unknown agent: ${requestedId}\n\n${nudge}` }],
          isError: true,
        };
      }

      if (stored) delivery?.execute({ kind: "mark-presented", deliveryId: stored.deliveryId });
      return { content: [{ type: "text", text: `${text}\n\n${nudge}` }] };
    }

    const agents = manager.listSnapshots();
    if (agents.length === 0) {
      return {
        content: [{ type: "text", text: `No agents running or completed.\n\n${nudge}` }],
      };
    }

    const formatted = agents.map(formatAgent).join(", ");
    return {
      content: [{ type: "text", text: `${formatted}\n\n${nudge}` }],
    };
  };
}
