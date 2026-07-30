import { getStatusNote } from "../status-note.js";
/**
 * tool-execution.ts — Agent tool execution handlers.
 *
 * Contains the execute callbacks registered for the Agent tool.
 * Spawn coordination and background nudge scheduling live in spawn-coordinator.ts.
 */

import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "../types.js";
import { SHORT_ID_LENGTH } from "../types.js";
import { resolveType, getAgentConfig, discoverNewAgents } from "./agent-types.js";
import { validateWorktreePath } from "../spawn/worktree-validator.js";

import {
  findModelInRegistry,
  parseThinkingLevel,
  parseModelSpec,
  resolveExactModel,
  unknownModelError,
} from "../utils.js";
import {
  scopedModelKeys,
  isModelInScope,
  outOfScopeModelError,
  modelKey,
  scopedThinkingLevel,
} from "../models/model-scope.js";
import {
  getPiInstance,
  getSessionCtx,
  getStore,
  getCoordinator,
  getManager,
} from "../shell.js";

// ============================================================================
// Tool result helpers
// ============================================================================

/** Shortcut for a successful tool result. */
function successResult(text: string) {
  return { content: [{ type: "text", text }] };
}

/** Shortcut for an error tool result. */
function errorResult(text: string) {
  return { content: [{ type: "text", text }], isError: true as const };
}

/**
 * Result text plus status note for foreground returns and background nudges.
 * Keeping one formatter prevents their completion semantics from drifting.
 */
export function formatResultContent(record: AgentRecord): string {
  if (record.lifecycle.status === "error") {
    return `Agent failed: ${record.error || "unknown error"}`;
  }
  return (record.result ?? "") + getStatusNote(record.lifecycle);
}

// ============================================================================
// Tool execute handlers
// ============================================================================

export async function executeAgentTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  ctx: ExtensionContext,
): Promise<any> {
  // Validate worktree_path early — needed for on-demand agent discovery
  const rawWorktreePath = params.worktree_path as string | undefined;
  let validatedWorktreePath: string | undefined;
  if (rawWorktreePath && rawWorktreePath.trim() !== "") {
    try {
      const parentCwd = getSessionCtx()?.cwd ?? ctx.cwd;
      const warnings: string[] = [];
      const onWarning = (msg: string) => { warnings.push(msg); };
      const validation = await validateWorktreePath(getPiInstance(), rawWorktreePath, parentCwd, onWarning);
      if (!validation.ok) {
        for (const msg of warnings) {
          if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents-lite] ${msg}`, "warning");
        }
        return errorResult(validation.error);
      }
      validatedWorktreePath = validation.resolvedPath;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`worktree_path validation failed: ${msg}`);
    }
  }

  const type = (params.agent as string) || "general-purpose";
  let resolvedType = resolveType(type);
  if (!resolvedType) {
    // Not found in registry — try scanning filesystem for agents added during the session.
    // When worktree_path is set, also scan the worktree's .pi/agents/ directory.
    const worktreeDir = validatedWorktreePath ? `${validatedWorktreePath}/.pi/agents` : undefined;
    await discoverNewAgents(worktreeDir);
    resolvedType = resolveType(type);
  }
  if (!resolvedType) {
    return errorResult(`Unknown agent type: ${type}`);
  }

  const prompt = params.prompt as string;
  const description = (params.description as string | undefined) || prompt.split("\n")[0].slice(0, 80) || prompt.slice(0, 80);
  const runInBackground = params.run_in_background as boolean | undefined;
  const maxTurns = getAgentConfig(resolvedType)?.maxTurns;
  const scopedModels = [...ctx.scopedModels];

  // model may be "id", "provider/id", or "id:thinking" / "provider/id:thinking".
  const { modelRef, thinkingFromModel } = parseModelSpec(params.model as string | undefined);
  let model = modelRef
    ? resolveExactModel(modelRef, ctx.modelRegistry, ctx.model?.provider)
    : undefined;

  // Explicit model was requested but could not be matched exactly → error (no silent parent fallback).
  if (modelRef && !model) {
    return errorResult(unknownModelError(modelRef));
  }

  // No explicit model → inherit injected/config/parent model (toolCallListener may have set params.model).
  if (!modelRef) {
    model = findModelInRegistry(undefined, ctx.modelRegistry, ctx.model);
  }

  // Reject models outside the active Model scope (--models / enabledModels).
  if (model) {
    const scopedKeys = scopedModelKeys(scopedModels);
    if (!isModelInScope(model, scopedKeys)) {
      return errorResult(outOfScopeModelError(modelKey(model), scopedKeys!));
    }
  }

  const resolvedModelKey = model ? modelKey(model) : undefined;

  // Determine modelName for invocation (always capture for display)
  const modelName = model?.id;

  // Only explicit choices are fixed at enqueue time. Scope pins are resolved
  // again by the runner so queued agents use the scope active when they start.
  const thinkingLevel = parseThinkingLevel(params.thinking as string | undefined)
    ?? thinkingFromModel;
  const displayThinkingLevel = thinkingLevel
    ?? scopedThinkingLevel(scopedModels, model)
    ?? getAgentConfig(resolvedType)?.thinkingLevel
    ?? getStore().agent.defaultThinking;

  // Use SpawnCoordinator for unified spawn path
  const coordinator = getCoordinator()!;
  const result = await coordinator.spawn(getPiInstance(), ctx, {
    type: resolvedType,
    prompt,
    description,
    model,
    modelKey: resolvedModelKey,
    maxTurns,
    thinkingLevel,
    graceTurns: getStore().agent.graceTurns,
    worktreePath: validatedWorktreePath,
    invocation: { modelName, thinkingLevel: displayThinkingLevel },
    runInBackground: runInBackground || getStore().agent.forceBackground,
  });

  const { agentId, record } = result;

  if (runInBackground || getStore().agent.forceBackground) {
    // Background: return immediately
    const suffix = `A notification will arrive when done — do NOT poll, sleep, timeout, check status, or redo the delegated work. The parent task advances automatically when the subagent completes.\n\nAgent ID: ${agentId}`;
    const label = record.lifecycle.status === "queued" ? "Agent queued" : "Agent running";
    return successResult(`[${label}] ${suffix}`);
  }

  // Foreground: record.execution.promise is already awaited by coordinator.spawn()
  const content = formatResultContent(record);
  return record.lifecycle.status === "error" ? errorResult(content) : successResult(content);
}

// ============================================================================
// Running agents list helper (used by executeStopAgentTool)
// ============================================================================

/**
 * Build a compact list of running (or queued) agents.
 * Format: "short_id (type), short_id (type)" — one line, easy for LLM to parse.
 */
function formatRunningAgents(): string {
  const agents = getManager()!.listAgents().filter(
    (a) => a.lifecycle.status === "running" || a.lifecycle.status === "queued",
  );

  if (agents.length === 0) return "none";

  return agents
    .map((a) => `${a.id.slice(0, SHORT_ID_LENGTH)} (${a.display.type})`)
    .join(", ");
}

// ============================================================================
// StopAgent execute handler
// ============================================================================

export async function executeStopAgentTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  _ctx: ExtensionContext,
): Promise<any> {
  const agentId = params.agent_id as string | undefined;

  if (!agentId) {
    return errorResult("agent_id is required");
  }

  const record = getManager()!.getRecord(agentId);

  if (!record) {
    // Agent not found → return error + list of running agents
    return errorResult(
      `Agent ${agentId} not found. Running agents: ${formatRunningAgents()}`,
    );
  }

  // Check if already in a terminal state (not running or queued)
  if (record.lifecycle.status !== "running" && record.lifecycle.status !== "queued") {
    return successResult(
      `Agent ${agentId} is already ${record.lifecycle.status}. Running agents: ${formatRunningAgents()}`,
    );
  }

  // Attempt to stop the running/queued agent
  if (getManager()!.abort(agentId, "agent")) {
    return successResult(`Stopped agent ${agentId.slice(0, SHORT_ID_LENGTH)}`);
  }

  return errorResult(`Failed to stop agent ${agentId}`);
}

// ============================================================================
// Tool_call listener — inject model into Agent tool calls
// =============================================================================

export async function toolCallListener(
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<void> {
  if (event.toolName !== "Agent") return;

  const input = event.input;
  const subagentType = input.agent as string | undefined;
  const agentConfig = subagentType ? getAgentConfig(subagentType) : undefined;

  // Normalize "model:thinking" shorthand before other injection logic.
  if (typeof input.model === "string" && input.model.length > 0) {
    const { modelRef, thinkingFromModel } = parseModelSpec(input.model);
    if (modelRef !== undefined) {
      input.model = modelRef;
    }
    // Promote thinking from model suffix only when thinking was not set explicitly.
    if (thinkingFromModel !== undefined && input.thinking === undefined) {
      input.thinking = thinkingFromModel;
    }
  }

  // Inject model only when the LLM did not pass one explicitly.
  // Explicit tool `model` always wins over config/parent defaults.
  if (input.model === undefined || input.model === null || input.model === "") {
    const parentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
    const effectiveModel = getStore().modelFor(
      subagentType ?? "general-purpose",
      parentModelId,
      agentConfig,
    );

    if (effectiveModel) {
      input.model = effectiveModel;
    }
  }

}
