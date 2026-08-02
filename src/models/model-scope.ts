/**
 * Model-scope helpers backed by Pi's resolved session scope.
 *
 * Pi 0.83 exposes the exact scope on ExtensionContext, including unsaved
 * session changes and per-pattern thinking levels. Keep that as the only
 * source of truth instead of re-parsing CLI arguments and settings here.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ScopedModel = ExtensionContext["scopedModels"][number];

/** Canonical model key used in scope sets and menu options. */
export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/** Resolve Pi's scoped model snapshot into canonical keys. */
export function scopedModelKeys(
  scopedModels: readonly ScopedModel[],
): Set<string> | null {
  if (scopedModels.length === 0) return null;
  return new Set(scopedModels.map(({ model }) => modelKey(model)));
}

/** Thinking level pinned to a model by the active scope, if any. */
export function scopedThinkingLevel(
  scopedModels: readonly ScopedModel[],
  model: { provider: string; id: string } | undefined,
): string | undefined {
  if (!model) return undefined;
  const key = modelKey(model);
  return scopedModels.find(({ model: scopedModel }) => modelKey(scopedModel) === key)?.thinkingLevel;
}

/** Build a clear error when provider authorization cannot be anchored to a parent model. */
export function missingParentModelError(): string {
  return "Cannot start an agent because the parent session has no active model. Select a parent model first.";
}

/** Build a clear error when no model can be resolved even though overrides are authorized. */
export function missingSubagentModelError(): string {
  return "Cannot start an agent because no subagent model could be resolved. Select a parent model or specify a model.";
}

/** Build a clear error when routing is OFF and a non-parent model was requested. */
export function routingDisabledModelError(modelRef: string): string {
  return (
    `Model "${modelRef}" cannot be used while Model routing is OFF: `
    + "subagents use the exact parent model. "
    + "Enable /agents > Settings > Model routing to authorize alternate models."
  );
}

export function providerDisabledError(modelRef: string, provider: string): string {
  return `Model "${modelRef}" is not authorized: provider "${provider}" is not enabled in Model routing.`;
}

export function agentProviderDeniedError(modelRef: string, agentType: string, provider: string): string {
  return `Model "${modelRef}" is not authorized: Agent "${agentType}" has no access rule for provider "${provider}".`;
}

export function modelDeniedError(modelRef: string, agentType: string): string {
  return `Model "${modelRef}" is not authorized by the saved model access rule for Agent "${agentType}".`;
}

export function modelUnavailableError(modelRef: string): string {
  return `Model "${modelRef}" is not available in the current Pi model registry.`;
}

/** Build a clear LLM/user-facing error for an out-of-scope model. */
export function outOfScopeModelError(
  modelRef: string,
  scopedKeys: ReadonlySet<string>,
): string {
  const allowed = [...scopedKeys].sort();
  const preview =
    allowed.length <= 8
      ? allowed.join(", ")
      : `${allowed.slice(0, 8).join(", ")}, ... (${allowed.length} total)`;
  return (
    `Model "${modelRef}" is not in the active model scope. ` +
    `Allowed: ${preview}. ` +
    "Adjust with /scoped-models or pick a model from the scope list."
  );
}

/** List model options for menus, filtered to Pi's active session scope. */
export function listModelOptionsForMenus(
  ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels">,
): string[] {
  const models = ctx.scopedModels.length > 0
    ? ctx.scopedModels.map(({ model }) => model)
    : ctx.modelRegistry.getAvailable();
  return models.map(modelKey);
}
