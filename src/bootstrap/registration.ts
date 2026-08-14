import { Type } from "typebox";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ThinkingLevelSchema } from "../modules/model-access/public.js";
import { createAgentToolExecutor, createStopAgentToolExecutor } from "./agent-tool.js";
import { createAgentStatusToolExecutor } from "./agent-status-tool.js";
import type { ExtensionRuntime } from "./extension-runtime.js";
import { showAgentsMenu } from "./settings.js";
import { SILENT_TOOL_RENDERING } from "../platform/pi/tui/silent-tool-rendering.js";

// ============================================================================
// Agent tool registration helper — stable schema for the runtime lifetime
// ============================================================================

/** Register the Agent tool once; per-run guidance lists current Agent types. */
function registerAgentTool(runtime: ExtensionRuntime): void {
  const agentParam = Type.Optional(Type.String());
  // @ts-expect-error — description removed to save prompt tokens
  runtime.pi.registerTool({
    name: "Agent",
    label: "Agent",
    parameters: Type.Object({
      prompt: Type.String(),
      description: Type.Optional(Type.String()),
      agent: agentParam,
      // Optional explicit alternate as an exact canonical provider/model key.
      model: Type.Optional(Type.String()),
      // The registered schema must offer exactly the levels authorization can
      // grant; a hand-written copy here would advertise a level the policy
      // rejects, and the model would spend a turn discovering it.
      thinking: Type.Optional(ThinkingLevelSchema),
      run_in_background: Type.Optional(Type.Boolean()),
      worktree_path: Type.Optional(Type.String({
        description: "Path to the parent repository's main checkout or a linked worktree; not an arbitrary cwd or another repository.",
      })),
    }, { additionalProperties: false }),
    execute: createAgentToolExecutor(runtime),

    ...SILENT_TOOL_RENDERING,
  });
}

// ============================================================================
// Tool/Command/Message registration
// ============================================================================

/** Register all tools, commands, and message renderers over one runtime. */
export function registerTools(runtime: ExtensionRuntime): void {
  const { pi } = runtime;

  // Agent tool — stable stealth schema; dynamic state lives in per-run guidance
  registerAgentTool(runtime);

  // StopAgent tool — stealth schema, stop a running agent by ID
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool({
    name: "StopAgent",
    label: "StopAgent",
    parameters: Type.Object({
      agent_id: Type.String(),
    }, { additionalProperties: false }),
    execute: createStopAgentToolExecutor(runtime),
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
    execute: createAgentStatusToolExecutor(runtime),
    ...SILENT_TOOL_RENDERING,
  });

  // Command registration
  pi.registerCommand("agents", {
    description: "Manage subagents: model access, concurrency, diagnostics, and agent types",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await showAgentsMenu(runtime, ctx);
    },
  });

  pi.registerShortcut("alt+a", {
    description: "Toggle subagent list",
    handler: () => runtime.navigator?.toggleList(),
  });
  pi.registerShortcut("alt+m", {
    description: "Return to Main agent",
    handler: () => runtime.navigator?.activateMain(),
  });
}
