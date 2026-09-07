import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { executeAgentTool, executeStopAgentTool } from "./agents/tool-execution.js";
import { executeAgentStatusTool } from "./agents/agent-status.js";
import { showAgentsMenu } from "./ui/menu/menus.js";
import { getNavigator } from "./shell.js";
import { VALID_THINKING_LEVELS } from "./models/thinking-resolver.js";

// Subagent state belongs to the below-editor list. Results still reach the LLM,
// but all three tools render zero chat rows so Pi's default tool cards cannot leak back in.
const SILENT_TOOL_RENDERING = {
  renderShell: "self" as const,
  renderCall: () => new Container(),
  renderResult: () => new Container(),
};

// ============================================================================
// Agent tool registration helper — stable schema for the runtime lifetime
// ============================================================================

/** Register the Agent tool once; per-run guidance lists current Agent types. */
export function registerAgentTool(pi: ExtensionAPI): void {
  const agentParam = Type.Optional(Type.String());
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool({
    name: "Agent",
    label: "Agent",
    parameters: Type.Object({
      prompt: Type.String(),
      description: Type.Optional(Type.String({
        description: "Short action phrase for the subagent list row (max 40 characters).",
      })),
      agent: agentParam,
      model: Type.Optional(Type.String({
        description: "Exact model ID or provider/model ID. Set thinking with the separate thinking field.",
      })),
      thinking: Type.Optional(Type.Union(VALID_THINKING_LEVELS.map(level => Type.Literal(level)), {
        description: "Thinking level supported by the selected model.",
      })),
      run_in_background: Type.Optional(Type.Boolean()),
      worktree_path: Type.Optional(Type.String({
        description: "Path to the parent repository's main checkout or a linked worktree; not an arbitrary cwd or another repository.",
      })),
    }, { additionalProperties: false }),
    execute: executeAgentTool,

    ...SILENT_TOOL_RENDERING,
  });
}

// ============================================================================
// Tool/Command/Message registration
// ============================================================================

/** Register all tools, commands, and message renderers. */
export function registerTools(pi: ExtensionAPI): void {
  // Agent tool — stable stealth schema; dynamic state lives in per-run guidance
  registerAgentTool(pi);

  // StopAgent tool — stealth schema, stop a running agent by ID
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool({
    name: "StopAgent",
    label: "StopAgent",
    parameters: Type.Object({
      agent_id: Type.String(),
    }, { additionalProperties: false }),
    execute: executeStopAgentTool,
    ...SILENT_TOOL_RENDERING,
  });

  // AgentStatus tool — stealth schema, list all agents or read one exact result.
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool({
    name: "AgentStatus",
    label: "AgentStatus",
    parameters: Type.Object({
      agent_id: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    execute: executeAgentStatusTool,
    ...SILENT_TOOL_RENDERING,
  });

  // Command registration
  pi.registerCommand("agents", {
    description: "Manage subagents: model access, concurrency, diagnostics, and agent types",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await showAgentsMenu(ctx);
    },
  });

  pi.registerShortcut("alt+a", {
    description: "Toggle subagent list",
    handler: () => getNavigator()?.toggleList(),
  });
  pi.registerShortcut("alt+m", {
    description: "Return to Main agent",
    handler: () => getNavigator()?.activateMain(),
  });
  pi.registerShortcut("alt+s", {
    description: "Deliver selected subagent messages",
    handler: (ctx) => {
      const navigator = getNavigator();
      if (navigator?.isListFocused()) {
        void navigator.openDeliverySelector(ctx.ui);
      }
    },
  });
}
