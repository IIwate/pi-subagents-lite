import { getStatusNote } from "../status-note.js";
/**
 * tool-execution.ts — Agent tool execution handlers.
 *
 * Contains the execute callbacks registered for the Agent tool.
 * Spawn coordination and background nudge scheduling live in spawn-coordinator.ts.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
  missingParentModelError,
  missingSubagentModelError,
  outOfScopeModelError,
  modelKey,
  scopedThinkingLevel,
  crossProviderModelError,
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
  const agentConfig = getAgentConfig(resolvedType);
  const maxTurns = agentConfig?.maxTurns;
  const scopedModels = [...ctx.scopedModels];
  const store = getStore();
  if (!ctx.model && !store.agent.allowCrossProvider) {
    return errorResult(missingParentModelError());
  }

  // Resolve here rather than mutating tool input in a listener, preserving
  // whether a queued model was explicit, automatic, or inherited.
  const explicitModel = typeof params.model === "string" && params.model.trim() !== "";
  const parentModelRef = ctx.model ? modelKey(ctx.model) : "";
  const automaticSelection = store.agent.allowCrossProvider
    ? store.modelSelectionFor(resolvedType, parentModelRef, agentConfig)
    : { model: parentModelRef, source: "parent" as const };
  const selectedModelSpec = explicitModel
    ? params.model as string
    : automaticSelection.model;
  const modelSource = explicitModel ? "explicit" : automaticSelection.source;
  const { modelRef, thinkingFromModel } = parseModelSpec(selectedModelSpec);
  const model = modelSource === "parent"
    ? findModelInRegistry(undefined, ctx.modelRegistry, ctx.model)
    : modelRef
      ? resolveExactModel(modelRef, ctx.modelRegistry, ctx.model?.provider)
      : findModelInRegistry(undefined, ctx.modelRegistry, ctx.model);

  if (modelRef && !model) {
    return errorResult(unknownModelError(modelRef));
  }
  if (!model) {
    return errorResult(missingSubagentModelError());
  }

  if (
    model
    && ctx.model
    && model.provider !== ctx.model.provider
    && !store.agent.allowCrossProvider
  ) {
    return errorResult(crossProviderModelError(modelKey(model), ctx.model.provider));
  }

  // Reject models outside the active Model scope (--models / enabledModels).
  if (model) {
    const scopedKeys = scopedModelKeys(scopedModels);
    if (!isModelInScope(model, scopedKeys)) {
      return errorResult(outOfScopeModelError(modelKey(model), scopedKeys!));
    }
  }

  const resolvedModelKey = model ? modelKey(model) : undefined;
  const resolveModelAtStart = modelSource === "automatic"
    ? () => {
      const currentStore = getStore();
      // A revoked permission must fail at runner validation rather than silently
      // changing an already-authorized automatic request into parent inheritance.
      if (!currentStore.agent.allowCrossProvider) {
        return { model, modelKey: resolvedModelKey! };
      }
      const currentParentRef = ctx.model ? modelKey(ctx.model) : "";
      const selection = currentStore.modelSelectionFor(resolvedType, currentParentRef, agentConfig);
      const currentSpec = parseModelSpec(selection.model);
      const currentModel = currentSpec.modelRef
        ? resolveExactModel(currentSpec.modelRef, ctx.modelRegistry, ctx.model?.provider)
        : findModelInRegistry(undefined, ctx.modelRegistry, ctx.model);
      if (!currentModel) {
        throw new Error(currentSpec.modelRef ? unknownModelError(currentSpec.modelRef) : missingSubagentModelError());
      }
      return {
        model: currentModel,
        modelKey: modelKey(currentModel),
        thinkingLevel: currentSpec.thinkingFromModel,
      };
    }
    : undefined;

  // Capture the predicted model/provider for queued-agent display.
  const modelName = model?.id;
  const providerName = model?.provider;

  // Only explicit choices are fixed at enqueue time. Scope pins are resolved
  // again by the runner so queued agents use the scope active when they start.
  const explicitThinkingLevel = parseThinkingLevel(params.thinking as string | undefined);
  const thinkingLevel = explicitThinkingLevel ?? thinkingFromModel;
  const thinkingSource = explicitThinkingLevel !== undefined
    ? "explicit"
    : thinkingFromModel !== undefined
      ? "automatic"
      : "inherited";
  const displayThinkingLevel = thinkingLevel
    ?? scopedThinkingLevel(scopedModels, model)
    ?? agentConfig?.thinkingLevel
    ?? store.agent.defaultThinking;

  // Use SpawnCoordinator for unified spawn path
  const coordinator = getCoordinator()!;
  const result = await coordinator.spawn(getPiInstance(), ctx, {
    type: resolvedType,
    prompt,
    description,
    model,
    modelSource,
    modelKey: resolvedModelKey,
    resolveModelAtStart,
    thinkingSource,
    maxTurns,
    thinkingLevel,
    graceTurns: store.agent.graceTurns,
    worktreePath: validatedWorktreePath,
    invocation: { modelName, providerName, thinkingLevel: displayThinkingLevel },
    runInBackground: runInBackground || store.agent.forceBackground,
  });

  const { agentId, record } = result;

  if (runInBackground || store.agent.forceBackground) {
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
