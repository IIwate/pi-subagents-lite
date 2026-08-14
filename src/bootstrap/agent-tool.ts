/**
 * agent-tool.ts — Agent and StopAgent tool execute callbacks.
 *
 * Translation between a Pi tool call and the capability modules: it validates
 * parameters, resolves access policy, and hands an accepted run to the runtime.
 * It owns no policy of its own, which is why it lives with the wiring.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getStatusNote } from "../status-note.js";
import type { AgentSnapshot } from "../modules/subagent-runtime/public.js";
import { SHORT_ID_LENGTH } from "../types.js";
import { parseAcceptedRunPolicy } from "../modules/subagent-runtime/public.js";

import {
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
} from "../modules/model-access/public.js";
import {
  authorizeModelAccess,
  resolveThinkingAccess,
  selectThinkingLevel,
} from "../modules/model-access/public.js";
import { piModelCapability } from "../platform/pi/agent-guidance-request.js";
import type { ExtensionRuntime } from "./extension-runtime.js";
import type { SubagentRuntime } from "../modules/subagent-runtime/public.js";
import { spawnAgent } from "./session-host.js";

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
export function formatResultContent(record: AgentSnapshot): string {
  if (record.status === "error") {
    return `Agent failed: ${record.error || "unknown error"}`;
  }
  return (record.result ?? "") + getStatusNote(record);
}

// ============================================================================
// Tool execute handlers
// ============================================================================

/** Bind the Agent tool execute callback to the composition-root runtime. */
export function createAgentToolExecutor(runtime: ExtensionRuntime) {
  return (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: any) => void) | undefined,
    ctx: ExtensionContext,
  ): Promise<any> => executeAgentTool(runtime, toolCallId, params, signal, onUpdate, ctx);
}

async function executeAgentTool(
  runtime: ExtensionRuntime,
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
    try {
      const parentCwd = runtime.sessionCtx?.cwd ?? ctx.cwd;
      const validation = await runtime.worktree.inspect({
        worktreePath: rawWorktreePath,
        parentCwd,
      });
      if (!validation.ok) {
        for (const msg of validation.warnings ?? []) {
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
  let resolvedType = runtime.agents.resolveType(type);
  if (!resolvedType) {
    // Not found in registry — try scanning filesystem for agents added during the session.
    // When worktree_path is set, also scan the worktree's .pi/agents/ directory.
    const worktreeDir = validatedWorktreePath ? `${validatedWorktreePath}/.pi/agents` : undefined;
    const discovered = await runtime.agents.discoverNew(worktreeDir);
    // A broken scan is reported instead of being read as "no such type": the
    // parent would otherwise correct a spelling that was never wrong.
    if (!discovered.ok) {
      return errorResult(`Agent type lookup failed: ${discovered.message}`);
    }
    resolvedType = runtime.agents.resolveType(type);
  }
  if (!resolvedType) {
    return errorResult(`Unknown agent type: ${type}`);
  }

  const prompt = params.prompt as string;
  const description = (params.description as string | undefined) || (prompt.split("\n")[0] || prompt).slice(0, 80);
  const requestedBackground = params.run_in_background as boolean | undefined;
  const agentSettings = runtime.agentSettings.read();
  const scopedModels = structuredClone(ctx.scopedModels);
  const runInBackground = requestedBackground === true || agentSettings.forceBackground;
  const routing = runtime.modelAccess();
  const explicitModel = Object.hasOwn(params, "model") && params.model !== undefined;
  if (!explicitModel && !ctx.model) return errorResult(missingParentModelError());

  const parentModelRef = ctx.model ? modelKey(ctx.model) : "";
  const selectedModelSpec = explicitModel && typeof params.model === "string"
    ? params.model.trim()
    : explicitModel
      ? ""
      : parentModelRef;
  const parsedModelKey = parseModelKey(selectedModelSpec);
  if (explicitModel && !parsedModelKey) return errorResult(unknownModelError(selectedModelSpec));
  if (!selectedModelSpec) return errorResult(missingSubagentModelError());
  const resolvedModelKey = selectedModelSpec;

  const scopedKeys = scopedModelKeys(scopedModels);
  const availableKeys = new Set(ctx.modelRegistry.getAvailable().map(modelKey));
  const verdict = authorizeModelAccess({
    kind: "authorize",
    agentType: resolvedType,
    modelKey: resolvedModelKey,
    parentModelKey: parentModelRef,
    routing,
    availableKeys: [...availableKeys],
    scopedKeys: scopedKeys ? [...scopedKeys] : null,
  });
  if ("error" in verdict) {
    return errorResult(`Agent "${resolvedType}" produced an invalid model access decision.`);
  }
  if (!verdict.ok) {
    const provider = resolvedModelKey.slice(0, resolvedModelKey.indexOf("/"));
    if (verdict.reason === "parent-model-denied") {
      return errorResult(`Agent "${resolvedType}" is not authorized to use the parent model.`);
    }
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

  const model = resolvedModelKey === parentModelRef && ctx.model
    ? ctx.model
    : resolveExactModel(resolvedModelKey, ctx.modelRegistry);
  if (!model) return errorResult(unknownModelError(resolvedModelKey));

  const policyInputs = runtime.agents.policyInputs(resolvedType, {
    loadSkillsImplicitly: agentSettings.loadSkillsImplicitly,
    loadExtensionsImplicitly: agentSettings.loadExtensionsImplicitly,
    systemPromptMode: agentSettings.systemPromptMode,
    includeContextFiles: agentSettings.includeContextFiles,
    parentModelKey: parentModelRef,
  });
  if (!policyInputs) {
    return errorResult(`Unknown agent type: ${type}`);
  }

  const configuredOutputLimit = policyInputs.definition.maxTokens;
  const acceptedModel = configuredOutputLimit != null && configuredOutputLimit > 0
    ? { ...structuredClone(model), maxTokens: configuredOutputLimit }
    : structuredClone(model);

  // Capture the predicted model/provider for queued-agent display.
  const modelName = acceptedModel.id;
  const providerName = acceptedModel.provider;

  // Resolve thinking now so queued work cannot observe later scope/config edits.
  const capability = piModelCapability(acceptedModel, scopedModels);
  const thinkingPolicy = resolveThinkingAccess({
    routing,
    agentType: resolvedType,
    modelKey: resolvedModelKey,
    parentModelKey: parentModelRef,
    parentThinkingLevel: ctx.thinkingLevel,
    scopedThinkingLevel: scopedThinkingLevel(scopedModels, model),
    supportedLevels: capability.supportedLevels,
    fallbackLevel: capability.fallbackLevel,
  });
  if (!thinkingPolicy) {
    return errorResult(`Model "${resolvedModelKey}" has no effective Thinking access policy for Agent "${resolvedType}".`);
  }
  const hasRequestedThinking = Object.hasOwn(params, "thinking") && params.thinking !== undefined;
  const requestedThinking = typeof params.thinking === "string" ? params.thinking.trim() : undefined;
  const thinkingSelection = hasRequestedThinking && requestedThinking === undefined
    ? { ok: false as const, reason: "thinking-denied" as const, allowed: [...thinkingPolicy.allowed] }
    : selectThinkingLevel(thinkingPolicy, requestedThinking);
  if (!thinkingSelection.ok) {
    return errorResult(
      `Thinking "${requestedThinking ?? ""}" is not authorized for Agent "${resolvedType}" on "${resolvedModelKey}". `
      + `Allowed thinking levels: ${thinkingSelection.allowed.join(", ")}.`,
    );
  }
  const thinkingLevel = thinkingSelection.level;
  const configuredTurnLimit = policyInputs.definition.maxTurns;
  const turnLimit = configuredTurnLimit == null || configuredTurnLimit === 0
    ? null
    : Math.max(1, configuredTurnLimit);
  const acceptedPolicy = parseAcceptedRunPolicy({
    ...policyInputs,
    model: acceptedModel,
    parentModel: ctx.model ? structuredClone(ctx.model) : null,
    scopedModels,
    thinkingLevel: thinkingLevel ?? null,
    outputTokenLimit: acceptedModel.maxTokens,
    turnLimit,
    graceTurns: agentSettings.graceTurns,
  });
  if (!acceptedPolicy) {
    return errorResult(`Agent "${resolvedType}" produced an invalid accepted run policy.`);
  }

  const result = await spawnAgent(runtime, ctx, {
    type: resolvedType,
    prompt,
    description,
    signal: runInBackground ? undefined : signal,
    acceptedPolicy,
    worktreePath: validatedWorktreePath,
    invocation: { modelName, providerName, thinkingLevel },
    runInBackground,
  });

  const { agentId, snapshot } = result;

  if (runInBackground) {
    const suffix = `The result will be delivered automatically when the parent can accept a turn. Do NOT poll, sleep, timeout, check status, or redo the delegated work.\n\nAgent ID: ${agentId}`;
    const label = snapshot.status === "queued" ? "Agent queued" : "Agent running";
    return successResult(`[${label}] ${suffix}`);
  }

  const content = formatResultContent(snapshot);
  return snapshot.status === "error" ? errorResult(content) : successResult(content);
}

// ============================================================================
// Running agents list helper (used by executeStopAgentTool)
// ============================================================================

/**
 * Build a compact list of running (or queued) agents.
 * Format: "short_id (type), short_id (type)" — one line, easy for LLM to parse.
 */
function formatRunningAgents(manager: SubagentRuntime): string {
  const agents = manager.listSnapshots().filter(
    (a) => a.status === "running" || a.status === "queued",
  );

  if (agents.length === 0) return "none";

  return agents
    .map((a) => `${a.id.slice(0, SHORT_ID_LENGTH)} (${a.type})`)
    .join(", ");
}

// ============================================================================
// StopAgent execute handler
// ============================================================================

/** Bind the StopAgent tool execute callback to the composition-root runtime. */
export function createStopAgentToolExecutor(runtime: ExtensionRuntime) {
  return async (
    _toolCallId: string,
    params: Record<string, unknown>,
    _signal: AbortSignal | undefined,
    _onUpdate: ((update: any) => void) | undefined,
    _ctx: ExtensionContext,
  ): Promise<any> => {
    const agentId = params.agent_id as string | undefined;

    if (!agentId) {
      return errorResult("agent_id is required");
    }

    // Tools only execute inside a session, after session_start created the manager.
    const manager = runtime.manager!;
    const record = manager.getSnapshot(agentId);

    if (!record) {
      // Agent not found → return error + list of running agents
      return errorResult(
        `Agent ${agentId} not found. Running agents: ${formatRunningAgents(manager)}`,
      );
    }

    // Check if already in a terminal state (not running or queued)
    if (record.status !== "running" && record.status !== "queued") {
      return successResult(
        `Agent ${agentId} is already ${record.status}. Running agents: ${formatRunningAgents(manager)}`,
      );
    }

    // Attempt to stop the running/queued agent
    if (manager.stop(agentId, "agent")) {
      return successResult(`Stopped agent ${agentId.slice(0, SHORT_ID_LENGTH)}`);
    }

    return errorResult(`Failed to stop agent ${agentId}`);
  };
}
