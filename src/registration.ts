import { Type } from "typebox";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { createAgentToolExecutor, createStopAgentToolExecutor } from "./agents/tool-execution.js";
import { createAgentStatusToolExecutor } from "./agents/agent-status.js";
import type { ExtensionRuntime } from "./bootstrap/extension-runtime.js";
import { showAgentsMenu } from "./bootstrap/settings.js";

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
export function registerAgentTool(runtime: ExtensionRuntime): void {
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
      thinking: Type.Optional(Type.Union([
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ])),
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
