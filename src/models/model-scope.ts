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

/** True when model is allowed (always true when scopedKeys is null). */
export function isModelInScope(
  model: { provider: string; id: string },
  scopedKeys: ReadonlySet<string> | null,
): boolean {
  return !scopedKeys || scopedKeys.has(modelKey(model));
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
