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
  parseThinkingLevel,
  parseModelKey,
  parseModelSpec,
  resolveExactModel,
  unknownModelError,
} from "../utils.js";
import {
  scopedModelKeys,
  missingParentModelError,
  missingSubagentModelError,
  outOfScopeModelError,
  modelKey,
  scopedThinkingLevel,
  routingDisabledModelError,
  providerDisabledError,
  agentProviderDeniedError,
  modelDeniedError,
  modelUnavailableError,
} from "../models/model-scope.js";
import { authorizeModel } from "../models/model-access.js";
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
  const description = (params.description as string | undefined) || (prompt.split("\n")[0] || prompt).slice(0, 80);
  const runInBackground = params.run_in_background as boolean | undefined;
  const agentConfig = getAgentConfig(resolvedType);
  const maxTurns = agentConfig?.maxTurns;
  const scopedModels = [...ctx.scopedModels];
  const store = getStore();
  const routing = store.routing;
  const explicitModel = typeof params.model === "string" && params.model.trim() !== "";
  if (!explicitModel && !ctx.model) return errorResult(missingParentModelError());

  const parentModelRef = ctx.model ? modelKey(ctx.model) : "";
  const selectedModelSpec = explicitModel ? params.model as string : parentModelRef;
  const { modelRef, thinkingFromModel } = parseModelSpec(selectedModelSpec);
  const explicitlyRequestsParent = Boolean(
    ctx.model
    && modelRef
    && (modelRef === parentModelRef || modelRef === ctx.model.id),
  );
  const model = explicitModel
    ? explicitlyRequestsParent
      ? ctx.model
      : modelRef
        ? resolveExactModel(modelRef, ctx.modelRegistry, ctx.model?.provider)
        : undefined
    : ctx.model;
  const parsedModelKey = modelRef ? parseModelKey(modelRef) : null;
  const resolvedModelKey = model
    ? modelKey(model)
    : parsedModelKey
      ? `${parsedModelKey.provider}/${parsedModelKey.modelId}`
      : "";

  if (explicitModel && modelRef && !resolvedModelKey) return errorResult(unknownModelError(modelRef));
  if (!resolvedModelKey) return errorResult(missingSubagentModelError());

  const scopedKeys = scopedModelKeys(scopedModels);
  const availableKeys = new Set(ctx.modelRegistry.getAvailable().map(modelKey));
  const verdict = authorizeModel({
    agentType: resolvedType,
    modelKey: resolvedModelKey,
    parentModelKey: parentModelRef,
    routing,
    availableKeys,
    scopedKeys,
  });
  if (!verdict.ok) {
    const provider = resolvedModelKey.slice(0, resolvedModelKey.indexOf("/"));
    if (verdict.reason === "out-of-scope") {
      return errorResult(outOfScopeModelError(resolvedModelKey, scopedKeys!));
    }
    if (verdict.reason === "routing-disabled") {
      return errorResult(routingDisabledModelError(selectedModelSpec));
    }
    if (verdict.reason === "provider-disabled") {
      return errorResult(providerDisabledError(resolvedModelKey, provider));
    }
    if (verdict.reason === "agent-provider-denied") {
      return errorResult(agentProviderDeniedError(resolvedModelKey, resolvedType, provider));
    }
    if (verdict.reason === "model-denied") {
      return errorResult(modelDeniedError(resolvedModelKey, resolvedType));
    }
    return errorResult(modelUnavailableError(resolvedModelKey));
  }
  if (!model) return errorResult(unknownModelError(modelRef!));

  // Capture the predicted model/provider for queued-agent display.
  const modelName = model?.id;
  const providerName = model?.provider;

  // Resolve thinking now so queued work cannot observe later scope/config edits.
  const explicitThinkingLevel = parseThinkingLevel(params.thinking as string | undefined);
  const thinkingLevel = explicitThinkingLevel
    ?? thinkingFromModel
    ?? scopedThinkingLevel(scopedModels, model)
    ?? agentConfig?.thinkingLevel
    ?? store.agent.defaultThinking
    ?? ctx.thinkingLevel;

  // Use SpawnCoordinator for unified spawn path
  const coordinator = getCoordinator()!;
  const result = await coordinator.spawn(getPiInstance(), ctx, {
    type: resolvedType,
    prompt,
    description,
    model,
    modelKey: resolvedModelKey,
    scopedModels,
    maxTurns,
    thinkingLevel,
    thinkingResolved: true,
    graceTurns: store.agent.graceTurns,
    worktreePath: validatedWorktreePath,
    invocation: { modelName, providerName, thinkingLevel },
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
