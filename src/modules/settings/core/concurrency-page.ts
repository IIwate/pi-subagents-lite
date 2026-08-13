import type { ConcurrencySettingsView, SettingsRow } from "../contracts/settings-contracts.js";

export const CONCURRENCY_LIMIT_MINIMUM = 1;

function limitLabel(limit: number): string {
  return `${limit} slot${limit === 1 ? "" : "s"}`;
}

/** Split a limit row id back into its scope and key. The page owns both sides of this encoding. */
export function parseLimitRowId(id: string): { scope: "provider" | "model"; key: string } | undefined {
  const separator = id.indexOf(":");
  if (separator <= 0) return undefined;
  const scope = id.slice(0, separator);
  const key = id.slice(separator + 1);
  if ((scope !== "provider" && scope !== "model") || key.length === 0) return undefined;
  return { scope, key };
}

function limitRow(options: {
  scope: "provider" | "model";
  key: string;
  limit: number;
  active: boolean;
}): SettingsRow {
  const scopeLabel = options.scope === "provider" ? "Provider" : "Model";
  return {
    id: `${options.scope}:${options.key}`,
    kind: "limit",
    label: `${options.active ? "" : "Inactive "}${scopeLabel} · ${options.key}`,
    detail: options.active
      ? (options.scope === "provider"
        ? "Shared hard ceiling across this Provider."
        : "Per-model hard ceiling, enforced with any Provider ceiling.")
      : `Saved limit for a ${scopeLabel} outside the active inventory; edit or remove.`,
    value: limitLabel(options.limit),
    input: String(options.limit),
    min: CONCURRENCY_LIMIT_MINIMUM,
  };
}

export function buildConcurrencyRows(view: ConcurrencySettingsView): SettingsRow[] {
  const activeProviders = new Set(view.activeProviders);
  const activeModels = new Set(view.activeModels);
  const isFactoryDefault = view.defaultLimit === view.factoryDefaultLimit;

  const rows: SettingsRow[] = [{
    id: "defaultConcurrency",
    kind: "numeric",
    label: "Fallback model limit",
    detail: "Per-model ceiling used when no Model override exists.",
    value: `${limitLabel(view.defaultLimit)}${isFactoryDefault ? " · Default" : ""}`,
    input: String(view.defaultLimit),
    min: CONCURRENCY_LIMIT_MINIMUM,
    // Clearing the input restores the factory default instead of erroring.
    fallback: view.factoryDefaultLimit,
  }];

  const providerEntries = Object.entries(view.providerLimits).sort(([a], [b]) => a.localeCompare(b));
  const modelEntries = Object.entries(view.modelLimits).sort(([a], [b]) => a.localeCompare(b));

  for (const [key, limit] of providerEntries) {
    if (activeProviders.has(key)) rows.push(limitRow({ scope: "provider", key, limit, active: true }));
  }
  for (const [key, limit] of modelEntries) {
    if (activeModels.has(key)) rows.push(limitRow({ scope: "model", key, limit, active: true }));
  }

  const addableProviders = view.activeProviders
    .filter((provider) => !Object.hasOwn(view.providerLimits, provider))
    .sort();
  if (addableProviders.length > 0) {
    rows.push({
      id: "addProviderLimit",
      kind: "picker",
      label: "Add Provider limit...",
      detail: "Shared hard ceiling across one Provider.",
      choices: addableProviders,
      min: CONCURRENCY_LIMIT_MINIMUM,
      input: "1",
    });
  }

  const addableModels = view.activeModels
    .filter((model) => !Object.hasOwn(view.modelLimits, model));
  if (addableModels.length > 0) {
    rows.push({
      id: "addModelLimit",
      kind: "picker",
      label: "Add Model limit...",
      detail: "Per-model hard ceiling, enforced with any Provider ceiling.",
      choices: addableModels,
      min: CONCURRENCY_LIMIT_MINIMUM,
      input: "1",
    });
  }

  // Saved-but-inactive overrides keep an explicit management path (edit or
  // remove) without pretending they limit anything right now.
  const inactive = [
    ...providerEntries
      .filter(([key]) => !activeProviders.has(key))
      .map(([key, limit]) => ({ scope: "provider" as const, key, limit })),
    ...modelEntries
      .filter(([key]) => !activeModels.has(key))
      .map(([key, limit]) => ({ scope: "model" as const, key, limit })),
  ].sort((a, b) => a.scope.localeCompare(b.scope) || a.key.localeCompare(b.key));
  for (const entry of inactive) {
    rows.push(limitRow({ ...entry, active: false }));
  }

  const hasOverrides = providerEntries.length > 0 || modelEntries.length > 0;
  if (!isFactoryDefault || hasOverrides) {
    rows.push({
      id: "resetAll",
      kind: "action",
      label: "Reset concurrency",
      detail: "Remove every override and restore the fallback default.",
      choices: ["Reset"],
      confirm: "Reset all concurrency limits?",
    });
  }

  return rows;
}
