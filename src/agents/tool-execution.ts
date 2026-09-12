import { getStatusNote } from "../status-note.js";
/**
 * tool-execution.ts — Agent tool execution handlers.
 *
 * Contains the execute callbacks registered for the Agent tool.
 * Accepted policy and native execution are owned by the activation runtime.
 */

import { CONFIG_DIR_NAME, type ExtensionContext, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import type { TaskOutcome } from "../domain/task.js";
import type { ExtensionRuntime } from "../runtime.js";
import { SHORT_ID_LENGTH } from "../types.js";
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
export function formatResultContent(outcome: TaskOutcome): string {
  if (outcome.status === "error") return `Agent failed: ${outcome.error}${outcome.result ? `\n\n${outcome.result}` : ""}`;
  return (outcome.result ?? "") + getStatusNote({ status: outcome.status, startedAt: 0, stoppedBy: "stoppedBy" in outcome ? outcome.stoppedBy : undefined });
}

// ============================================================================
// Tool execute handlers
// ============================================================================

export async function executeAgentTool(
  runtime: ExtensionRuntime,
  _toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  ctx: ExtensionContext,
): Promise<any> {
  runtime.assertContext(ctx);
  const parentEntryId = ctx.sessionManager.getLeafId();
  // Validate worktree_path early — needed for on-demand agent discovery
  const rawWorktreePath = params.worktree_path as string | undefined;
  let validatedWorktreePath: string | undefined;
  if (rawWorktreePath && rawWorktreePath.trim() !== "") {
    const parentCwd = runtime.context?.cwd ?? ctx.cwd;
    const warnings: string[] = [];
    const onWarning = (msg: string) => { warnings.push(msg); };
    let validation;
    try {
      validation = await validateWorktreePath(runtime.pi, rawWorktreePath, parentCwd, onWarning);
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
  let resolvedType = runtime.catalogue.resolveType(type);
  if (!resolvedType) {
    // Not found in registry — try scanning filesystem for agents added during the session.
    // When worktree_path is set, also scan the worktree's .pi/agents/ directory.
    const worktreeDir = validatedWorktreePath && ctx.isProjectTrusted?.() !== false
      ? join(validatedWorktreePath, CONFIG_DIR_NAME, "agents")
      : undefined;
    await runtime.catalogue.discoverNewAgents(worktreeDir);
    resolvedType = runtime.catalogue.resolveType(type);
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
  const store = runtime.store;

  if (requestedBackground !== true && store.agent.forceBackground) {
    throw new Error(
      "Foreground execution is disabled: the user has enabled 'forceBackground' in subagent settings. "
      + "You must explicitly set 'run_in_background: true' to spawn this subagent asynchronously, "
      + "or inform the user that their current configuration forbids foreground execution.",
    );
  }

  const runInBackground = requestedBackground === true;
  const scopedModels = [...ctx.scopedModels];
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
  const acceptedPolicy = runtime.catalogue.resolveAcceptedRunPolicy(resolvedType, {
    loadSkillsImplicitly: store.agent.loadSkillsImplicitly,
    loadExtensionsImplicitly: store.agent.loadExtensionsImplicitly,
    systemPromptMode: store.agent.systemPromptMode,
    includeContextFiles: store.agent.includeContextFiles,
    parentModelKey: parentModelRef,
    defaultTools,
  });
  if (!acceptedPolicy) throw new Error(`Unknown agent type: ${type}`);

  const acceptedModel = model;


  // Resolve thinking now so queued work cannot observe later scope/config edits.
  const thinkingLevel = resolveThinkingLevel({
    model: acceptedModel,
    thinking: params.thinking as string | undefined,
    agentThinking: acceptedPolicy.definition.thinkingLevel,
    scopedThinking: scopedThinkingLevel(scopedModels, acceptedModel),
    defaultThinking: store.agent.defaultThinking,
    parentThinking: ctx.thinkingLevel,
  });

  const { task, detached } = await runtime.spawn({ ctx, parentEntryId, prompt, description, acceptedPolicy, model: acceptedModel,
    thinkingLevel: thinkingLevel ?? "off", graceTurns: store.agent.graceTurns, worktreePath: validatedWorktreePath,
    runInBackground, signal: runInBackground ? undefined : signal });
  if (detached) return successResult("[Subagent detached: User took over this session. Wait for user delivery or explicit status lookup.]");
  if (runInBackground) return successResult(`[Agent ${task.state.status}] The result will be delivered automatically when the parent can accept a turn. Do NOT poll, sleep, timeout, check status, or redo the delegated work.\n\nAgent ID: ${task.taskId}`);
  const content = task.state.status === "settled" ? formatResultContent(task.state.outcome) : `Agent ${task.state.status}`;
  return task.state.status === "settled" && task.state.outcome.status === "error" ? errorResult(content) : successResult(content);
}

export async function executeStopAgentTool(
  runtime: ExtensionRuntime, _toolCallId: string, params: Record<string, unknown>,
  _signal: AbortSignal | undefined, _onUpdate: ((update: any) => void) | undefined, ctx: ExtensionContext,
): Promise<any> {
  runtime.assertContext(ctx);
  const id = typeof params.agent_id === "string" ? params.agent_id.trim() : "";
  const tasks = runtime.engine.list();
  const task = tasks.find(task => task.taskId === id);
  const running = () => tasks.filter(task => task.state.status !== "settled")
    .map(task => `${task.taskId.slice(0, SHORT_ID_LENGTH)} (${task.policy.agent})`).join(", ") || "none";
  if (!id) return errorResult("agent_id is required");
  if (!task) return errorResult(`Agent ${id} not found. Running agents: ${running()}`);
  if (task.state.status === "settled") return successResult(`Agent ${id} is already ${task.state.outcome.status}. Running agents: ${running()}`);
  await runtime.engine.requestAbort(id, "agent");
  return successResult(`Stopped agent ${id.slice(0, SHORT_ID_LENGTH)}`);
}
