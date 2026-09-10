import { getStatusNote } from "../status-note.js";
/**
 * tool-execution.ts — Agent tool execution handlers.
 *
 * Contains the execute callbacks registered for the Agent tool.
 * Spawn coordination and background nudge scheduling live in spawn-coordinator.ts.
 */

import { CONFIG_DIR_NAME, type ExtensionContext, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import type { AgentRecord } from "../types.js";
import { SHORT_ID_LENGTH } from "../types.js";
import { resolveType, resolveAcceptedRunPolicy, discoverNewAgents } from "./agent-types.js";
import { validateWorktreePath } from "../spawn/worktree-validator.js";

import {
  errorMessage,
  parseModelKey,
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
import { resolveThinkingLevel } from "../models/thinking-resolver.js";
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
  signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  ctx: ExtensionContext,
): Promise<any> {
  // Validate worktree_path early — needed for on-demand agent discovery
  const rawWorktreePath = params.worktree_path as string | undefined;
  let validatedWorktreePath: string | undefined;
  if (rawWorktreePath && rawWorktreePath.trim() !== "") {
    const parentCwd = getSessionCtx()?.cwd ?? ctx.cwd;
    const warnings: string[] = [];
    const onWarning = (msg: string) => { warnings.push(msg); };
    let validation;
    try {
      validation = await validateWorktreePath(getPiInstance(), rawWorktreePath, parentCwd, onWarning);
    } catch (err: unknown) {
      throw new Error(`worktree_path validation failed: ${errorMessage(err)}`);
    }
    if (!validation.ok) {
      for (const msg of warnings) {
        if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents-lite] ${msg}`, "warning");
      }
      throw new Error(validation.error);
    }
    validatedWorktreePath = validation.resolvedPath;
  }

  const type = (params.agent as string) || "general-purpose";
  let resolvedType = resolveType(type);
  if (!resolvedType) {
    // Not found in registry — try scanning filesystem for agents added during the session.
    // When worktree_path is set, also scan the worktree's .pi/agents/ directory.
    const worktreeDir = validatedWorktreePath && ctx.isProjectTrusted?.() !== false
      ? join(validatedWorktreePath, CONFIG_DIR_NAME, "agents")
      : undefined;
    await discoverNewAgents(worktreeDir);
    resolvedType = resolveType(type);
  }
  if (!resolvedType) {
    throw new Error(`Unknown agent type: ${type}`);
  }

  const prompt = params.prompt as string;
  const rawDescription = (params.description as string | undefined) || (prompt.split("\n")[0] || prompt);
  const description = (rawDescription.split("\n")[0] || "").trim().slice(0, 40);
  const requestedBackground = typeof params.run_in_background === "boolean"
    ? params.run_in_background
    : undefined;
  const store = getStore();

  if (requestedBackground !== true && store.agent.forceBackground) {
    throw new Error(
      "Foreground execution is disabled: the user has enabled 'forceBackground' in subagent settings. "
      + "You must explicitly set 'run_in_background: true' to spawn this subagent asynchronously, "
      + "or inform the user that their current configuration forbids foreground execution.",
    );
  }

  const runInBackground = requestedBackground === true;
  const scopedModels = structuredClone(ctx.scopedModels);
  const routing = store.routing;
  const explicitModelRef = typeof params.model === "string" ? params.model.trim() || undefined : undefined;
  const explicitModel = explicitModelRef !== undefined;
  if (!explicitModel && !ctx.model) throw new Error(missingParentModelError());

  const parentModelRef = ctx.model ? modelKey(ctx.model) : "";
  const modelRef = explicitModelRef ?? parentModelRef;
  if (explicitModel && modelRef.includes(":")) throw new Error(unknownModelError(modelRef));
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

  if (explicitModel && modelRef && !resolvedModelKey) throw new Error(unknownModelError(modelRef));
  if (!resolvedModelKey) throw new Error(missingSubagentModelError());

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
      throw new Error(outOfScopeModelError(resolvedModelKey, scopedKeys!));
    }
    if (verdict.reason === "routing-disabled") {
      throw new Error(routingDisabledModelError(modelRef));
    }
    if (verdict.reason === "provider-disabled") {
      throw new Error(providerDisabledError(resolvedModelKey, provider));
    }
    if (verdict.reason === "agent-provider-denied") {
      throw new Error(agentProviderDeniedError(resolvedModelKey, resolvedType, provider));
    }
    if (verdict.reason === "model-denied") {
      throw new Error(modelDeniedError(resolvedModelKey, resolvedType));
    }
    throw new Error(modelUnavailableError(resolvedModelKey));
  }
  if (!model) throw new Error(unknownModelError(modelRef!));

  let defaultTools: string[] | undefined;
  try {
    defaultTools = (ctx as any).settingsManager?.getDefaultTools?.()
      ?? SettingsManager.create?.(ctx.cwd, getAgentDir())?.getDefaultTools?.();
  } catch {
    // Ignore settings resolution errors in environments where settings cannot be read
  }
  const acceptedPolicy = resolveAcceptedRunPolicy(resolvedType, {
    loadSkillsImplicitly: store.agent.loadSkillsImplicitly,
    loadExtensionsImplicitly: store.agent.loadExtensionsImplicitly,
    systemPromptMode: store.agent.systemPromptMode,
    includeContextFiles: store.agent.includeContextFiles,
    parentModelKey: parentModelRef,
    defaultTools,
  });
  if (!acceptedPolicy) throw new Error(`Unknown agent type: ${type}`);
  const maxTurns = acceptedPolicy.definition.maxTurns;

  const acceptedModel = structuredClone(model);

  // Capture the accepted model/provider for queued-agent display.
  const modelName = acceptedModel.id;
  const providerName = acceptedModel.provider;

  // Resolve thinking now so queued work cannot observe later scope/config edits.
  const thinkingLevel = resolveThinkingLevel({
    model: acceptedModel,
    thinking: params.thinking as string | undefined,
    agentThinking: acceptedPolicy.definition.thinkingLevel,
    scopedThinking: scopedThinkingLevel(scopedModels, acceptedModel),
    defaultThinking: store.agent.defaultThinking,
    parentThinking: ctx.thinkingLevel,
  });

  // Use SpawnCoordinator for unified spawn path
  const coordinator = getCoordinator()!;
  const result = await coordinator.spawn(getPiInstance(), ctx, {
    type: resolvedType,
    prompt,
    description,
    signal: runInBackground ? undefined : signal,
    acceptedPolicy,
    model: acceptedModel,
    modelKey: resolvedModelKey,
    scopedModels,
    maxTurns,
    thinkingLevel,
    graceTurns: store.agent.graceTurns,
    worktreePath: validatedWorktreePath,
    invocation: Object.freeze({ modelName, providerName, thinkingLevel }),
    runInBackground,
  });

  const { agentId, record } = result;

  if (result.detached) {
    return successResult(
      "[Subagent detached to background: User took over this session interactively in the child view. Wait for user delivery or explicit status lookup.]",
    );
  }

  if (runInBackground) {
    const suffix = `The result will be delivered automatically when the parent can accept a turn. Do NOT poll, sleep, timeout, check status, or redo the delegated work.\n\nAgent ID: ${agentId}`;
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
