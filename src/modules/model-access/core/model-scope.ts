/**
 * Canonical keys, host-supplied scope snapshots, and authorization error text.
 *
 * The host passes the resolved scope in; this file never re-parses CLI
 * arguments or settings. The snapshot shape is the repo-owned subset these
 * helpers read, so a different host can supply the same records. Error
 * strings live here so bootstrap and the Pi adapter do not grow a third copy.
 */

interface ScopedModel {
  model: { provider: string; id: string };
  thinkingLevel?: string;
}

/** Canonical model key used in scope sets and settings views. */
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
    `Model "${modelRef}" cannot be used while Alternate models are OFF. `
    + "Parent model access is configured separately. "
    + "Enable /agents > Model access > Alternate models to authorize alternates."
  );
}

export function providerDisabledError(modelRef: string, provider: string): string {
  return `Model "${modelRef}" is not authorized: provider "${provider}" is disabled in Model access.`;
}

export function agentProviderDeniedError(modelRef: string, agentType: string, provider: string): string {
  return `Model "${modelRef}" is not authorized: Agent "${agentType}" has no access rule for provider "${provider}".`;
}

export function modelDeniedError(modelRef: string, agentType: string): string {
  return `Model "${modelRef}" is not authorized by the saved model access rule for Agent "${agentType}".`;
}

export function modelUnavailableError(modelRef: string): string {
  return `Model "${modelRef}" is not currently available to Pi.`;
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
