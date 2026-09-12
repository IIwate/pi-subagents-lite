import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionRuntime } from "../runtime.js";
import { formatResultContent } from "./tool-execution.js";

export async function executeAgentStatusTool(
  runtime: ExtensionRuntime, _toolCallId: string, params: Record<string, unknown>,
  _signal: AbortSignal | undefined, _onUpdate: ((update: any) => void) | undefined, ctx: ExtensionContext,
): Promise<any> {
  runtime.assertContext(ctx);
  const id = typeof params.agent_id === "string" ? params.agent_id.trim() : "";
  const tasks = runtime.engine.list();
  const nudge = "Don't poll, sleep, or timeout-wait — background results are delivered automatically.";
  const task = id ? tasks.find(task => task.taskId === id) : undefined;
  const stored = id && !task ? await runtime.storedResult(id) : undefined;
  if (id && !task && !stored) return { content: [{ type: "text", text: `Unknown agent: ${id}\n\n${nudge}` }], isError: true };
  const outcome = task?.state.status === "settled" ? task.state.outcome : stored?.result?.outcome;
  const policy = task?.policy ?? stored?.binding.policy;
  const text = policy
    ? `Agent ${id}: ${outcome?.status ?? task?.state.status ?? "unavailable"}\nProvider: ${policy.model.provider}\nModel: ${policy.model.id}\nResult:\n${outcome ? formatResultContent(outcome) : "No settled result."}`
    : tasks.map(task => `${task.taskId} (${task.policy.agent}) ${task.state.status === "settled" ? task.state.outcome.status : task.state.status}`).join(", ") || "No agents running or completed.";
  const deliveries = task ? await runtime.engine.storedDeliveries(id) : stored?.deliveries ?? [];
  const operationId = task?.operationId ?? stored?.result?.operationId;
  const presented = deliveries.filter(item => item.delivery.operationId === operationId && text.includes(item.delivery.text));
  return { content: [{ type: "text", text: `${text}\n\n${nudge}` }], details: presented.length ? {
    parentSessionId: ctx.sessionManager.getSessionId(), deliveries: presented.map(item => item.delivery),
  } : undefined };
}
