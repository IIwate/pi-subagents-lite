import type {
  ConcurrencySettingsView,
  SettingsRow,
} from "../contracts/settings-contracts.js";
import type { ConcurrencyTarget, ConcurrencyValueSource } from "../../subagent-runtime/public.js";

export const CONCURRENCY_LIMIT_MINIMUM = 1;

function limitLabel(limit: number): string {
  return `${limit} slot${limit === 1 ? "" : "s"}`;
}

const SOURCE_TAGS: Record<ConcurrencyValueSource, string> = {
  default: "Default",
  global: "Global",
  project: "Project",
};

export function targetLabel(target: ConcurrencyTarget): string {
  return target === "global" ? "Global" : "Project";
}

/** The selected write target's sparse fragment; rows derive from it, display from effective. */
function layerFragment(view: ConcurrencySettingsView, target: ConcurrencyTarget) {
  return target === "global" ? view.global : view.project;
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
  layerLimit: number;
  effectiveLimit: number;
  source: ConcurrencyValueSource;
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
    value: `${limitLabel(options.effectiveLimit)} · ${SOURCE_TAGS[options.source]}`,
    input: String(options.layerLimit),
    min: CONCURRENCY_LIMIT_MINIMUM,
  };
}

export function buildConcurrencyRows(view: ConcurrencySettingsView, target: ConcurrencyTarget): SettingsRow[] {
  const layer = layerFragment(view, target);
  const layerProviders = layer.providers ?? {};
  const layerModels = layer.models ?? {};
  const activeProviders = new Set(view.activeProviders);
  const activeModels = new Set(view.activeModels);

  const rows: SettingsRow[] = [];

  // The project layer is described even when the user is writing globally,
  // because effective values on this page can come from either file.
  if (view.projectLayer.state !== "untrusted") {
    const warning = view.projectLayer.ignoredEntryCount > 0
      ? ` · ${view.projectLayer.ignoredEntryCount} unusable entr${view.projectLayer.ignoredEntryCount === 1 ? "y" : "ies"} ignored`
      : "";
    rows.push({
      id: "projectLayerNote",
      kind: "note",
      label: `Project config · ${view.projectLayer.state}${warning}`,
      ...(view.projectLayer.filePath ? { detail: view.projectLayer.filePath } : {}),
    });
  }
  if (view.projectLayer.writable) {
    rows.push({
      id: "writeTarget",
      kind: "choice",
      label: "Write target",
      detail: "Layer edited by the rows below; effective values always show merged state.",
      value: targetLabel(target),
      choices: ["Global", "Project"],
    });
  }

  // An explicit default is managed like a keyed override (edit or remove;
  // removal restores inheritance on the project layer and the factory
  // default on the global layer). Without one, the row stays a plain
  // numeric input whose cleared field falls back to the factory value.
  rows.push(layer.default !== undefined
    ? {
      id: "defaultConcurrency",
      kind: "limit",
      label: "Fallback model limit",
      detail: "Per-model ceiling used when no Model override exists.",
      value: `${limitLabel(view.effective.default)} · ${SOURCE_TAGS[view.provenance.default]}`,
      input: String(layer.default),
      min: CONCURRENCY_LIMIT_MINIMUM,
    }
    : {
      id: "defaultConcurrency",
      kind: "numeric",
      label: "Fallback model limit",
      detail: "Per-model ceiling used when no Model override exists.",
      value: `${limitLabel(view.effective.default)} · ${SOURCE_TAGS[view.provenance.default]}`,
      input: String(view.factoryDefaultLimit),
      min: CONCURRENCY_LIMIT_MINIMUM,
      // Clearing the input restores the factory default instead of erroring.
      fallback: view.factoryDefaultLimit,
    });

  const providerEntries = Object.entries(layerProviders).sort(([a], [b]) => a.localeCompare(b));
  const modelEntries = Object.entries(layerModels).sort(([a], [b]) => a.localeCompare(b));
  const rowFor = (scope: "provider" | "model", key: string, layerLimit: number, active: boolean): SettingsRow => {
    const container = scope === "provider" ? "providers" : "models";
    return limitRow({
      scope,
      key,
      layerLimit,
      effectiveLimit: view.effective[container][key] ?? layerLimit,
      source: view.provenance[container][key] ?? target,
      active,
    });
  };

  for (const [key, limit] of providerEntries) {
    if (activeProviders.has(key)) rows.push(rowFor("provider", key, limit, true));
  }
  for (const [key, limit] of modelEntries) {
    if (activeModels.has(key)) rows.push(rowFor("model", key, limit, true));
  }

  const addableProviders = view.activeProviders
    .filter((provider) => !Object.hasOwn(layerProviders, provider))
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
    .filter((model) => !Object.hasOwn(layerModels, model));
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
    rows.push(rowFor(entry.scope, entry.key, entry.limit, false));
  }

  // Reset reflects the selected layer only: a project layer with no
  // overrides (absent file included) offers nothing to reset.
  const hasOverrides = providerEntries.length > 0 || modelEntries.length > 0;
  const defaultDiffers = target === "global"
    ? layer.default !== undefined && layer.default !== view.factoryDefaultLimit
    : layer.default !== undefined;
  if (defaultDiffers || hasOverrides) {
    rows.push({
      id: "resetAll",
      kind: "action",
      label: target === "global" ? "Reset concurrency" : "Reset project overrides",
      detail: target === "global"
        ? "Remove every override and restore the fallback default."
        : "Remove every project override and restore inheritance.",
      choices: ["Reset"],
      confirm: target === "global"
        ? "Reset all concurrency limits?"
        : "Reset all project concurrency overrides?",
    });
  }

  return rows;
}
