/**
 * model-access-pages.ts — Row builders and row-id codecs for the model-access
 * section. Pages present precomputed owner views; the decision tables and
 * rule transitions stay behind the owner port (REQ-SETTINGS-002). Checkbox
 * state is rendered into labels because these pages are select-driven menus:
 * one activation toggles or navigates, and the snapshot is rebuilt.
 */

import type {
  ModelAccessAgentDetailView,
  ModelAccessAgentRow,
  ModelAccessModelsView,
  ModelAccessProvidersView,
  ModelAccessRootView,
  ModelAccessThinkingTarget,
  ModelAccessThinkingView,
  ModelAccessUnavailableProvider,
  SettingsRow,
} from "../contracts/settings-contracts.js";

function checkbox(checked: boolean, label: string): string {
  return `[${checked ? "x" : " "}] ${label}`;
}

/** Prefixed row ids carry the subject key; the page owns both sides of the encoding. */
export function keyForRow(id: string, prefix: string): string | undefined {
  return id.startsWith(prefix) && id.length > prefix.length ? id.slice(prefix.length) : undefined;
}

function parentDefaultRow(parentModelKey: string): SettingsRow {
  return parentModelKey === ""
    ? {
        id: "parentDefault",
        kind: "note",
        label: "Parent default · No active parent model",
        detail: "Unavailable until a parent model is selected",
      }
    : {
        id: "parentDefault",
        kind: "note",
        label: `Parent default · ${parentModelKey}`,
      };
}

export function buildModelAccessRootRows(view: ModelAccessRootView): SettingsRow[] {
  const rows: SettingsRow[] = [
    {
      id: "alternateModels",
      kind: "toggle",
      label: "Alternate models",
      value: view.enabled ? "ON" : "OFF",
    },
    {
      id: "quickSetup",
      kind: "category",
      label: "Quick model setup",
      detail: "Current-Provider model access per Agent",
    },
  ];
  if (view.enabled) {
    rows.push({
      id: "providerAccess",
      kind: "category",
      label: "Provider access",
      detail: `${view.enabledProviderCount} enabled`,
    });
  }
  rows.push({
    id: "agentAccess",
    kind: "category",
    label: "Agent access",
    detail: `${view.configuredAgentCount} configured`,
  });
  if (view.enabled && view.unavailableProviders.length > 0) {
    rows.push({
      id: "unavailableProviders",
      kind: "category",
      label: "Saved unavailable providers",
      detail: String(view.unavailableProviders.length),
    });
  }
  if (view.enabled && view.unavailableRules.length > 0) {
    rows.push({
      id: "cleanUnavailableRules",
      kind: "action",
      label: "Clean unavailable rules",
      detail: String(view.unavailableRules.length),
      choices: ["Clean"],
      confirm: cleanUnavailableConfirmMessage(view),
    });
  }
  rows.push({
    id: "resetAll",
    kind: "action",
    label: "Reset Model access",
    choices: ["Reset"],
    confirm: "Reset all Model access settings?",
  });
  return rows;
}

/** Multiline confirmation listing every rule the cleanup would delete. */
function cleanUnavailableConfirmMessage(view: ModelAccessRootView): string {
  const count = view.unavailableRules.length;
  return [
    `Remove ${count} unavailable model access rule${count === 1 ? "" : "s"}?`,
    "",
    ...view.unavailableRules.flatMap(({ provider, agentType, modelId }) => [
      `- Provider: ${provider}`,
      `  - Agent: ${agentType}`,
      `    - Model: ${modelId}`,
    ]),
  ].join("\n");
}

export function buildAgentListRows(agents: readonly ModelAccessAgentRow[]): SettingsRow[] {
  return agents.map((agent) => ({
    id: `type:${agent.type}`,
    kind: "category",
    label: agent.registered ? agent.type : `${agent.type} (agent unavailable)`,
    detail: agent.summary,
  }));
}

export function buildProvidersRows(view: ModelAccessProvidersView): SettingsRow[] {
  const rows: SettingsRow[] = [parentDefaultRow(view.parentModelKey)];
  if (view.providers.length === 0) {
    rows.push({ id: "emptyProviders", kind: "note", label: "No alternate providers available" });
    return rows;
  }
  for (const { provider, enabled } of view.providers) {
    rows.push({
      id: `provider:${provider}`,
      kind: "toggle",
      label: checkbox(enabled, provider),
    });
  }
  return rows;
}

export function buildAgentDetailRows(view: ModelAccessAgentDetailView): SettingsRow[] {
  const rows: SettingsRow[] = [];
  if (view.parentModelKey === "") {
    rows.push({
      id: "parentAccess",
      kind: "note",
      label: "[ ] Use parent model · No active parent model",
      detail: "Unavailable until a parent model is selected",
    });
  } else {
    rows.push({
      id: "parentAccess",
      kind: "toggle",
      label: checkbox(view.parentAllowed, `Use parent model · ${view.parentModelKey} · ${view.parentDefaultLevel || "unavailable"}`),
    });
  }
  for (const provider of view.providers) {
    rows.push({
      id: `provider:${provider}`,
      kind: "category",
      label: provider,
      detail: "Model access for this Provider",
    });
  }
  if (view.thinkingTargetCount > 0) {
    rows.push({
      id: "thinking",
      kind: "category",
      label: "Thinking policies",
      detail: "Allowed and default levels per usable model",
    });
  }
  return rows;
}

export function buildModelsRows(view: ModelAccessModelsView): SettingsRow[] {
  const rows: SettingsRow[] = [parentDefaultRow(view.parentModelKey)];
  if (view.models.length === 0) {
    rows.push({ id: "emptyModels", kind: "note", label: "No alternate models available" });
    return rows;
  }
  rows.push({
    id: "all",
    kind: "toggle",
    label: checkbox(view.allModels, "All models"),
  });
  for (const { id, granted } of view.models) {
    rows.push({
      id: `model:${id}`,
      kind: "toggle",
      label: checkbox(!view.allModels && granted, id),
    });
  }
  return rows;
}

export function buildThinkingTargetRows(targets: readonly ModelAccessThinkingTarget[]): SettingsRow[] {
  if (targets.length === 0) {
    return [{ id: "emptyTargets", kind: "note", label: "No usable models for this Agent" }];
  }
  return targets.map((target) => ({
    id: `target:${target.key}`,
    kind: "category",
    label: target.parent ? `Parent model · ${target.key}` : target.key,
  }));
}

export function buildThinkingRows(view: ModelAccessThinkingView): SettingsRow[] {
  const rows: SettingsRow[] = view.levels.map(({ level, allowed, isDefault }) => ({
    id: `level:${level}`,
    kind: "toggle",
    label: checkbox(allowed, `${level}${isDefault ? " · default" : ""}`),
  }));
  const currentDefault = view.levels.find((entry) => entry.isDefault);
  rows.push({
    id: "default",
    kind: "action",
    label: "Default level",
    detail: "Cycles through the allowed levels",
    value: currentDefault?.level ?? "",
    choices: ["Next"],
  });
  rows.push({
    id: "reset",
    kind: "action",
    label: "Reset baseline",
    detail: "Remove the saved override for this model",
    choices: ["Reset"],
  });
  return rows;
}

/** The allowed level the cycle gesture moves the default to; undefined when nothing else is allowed. */
export function nextThinkingDefault(view: ModelAccessThinkingView): string | undefined {
  const allowed = view.levels.filter((entry) => entry.allowed);
  if (allowed.length === 0) return undefined;
  const currentIndex = allowed.findIndex((entry) => entry.isDefault);
  const next = allowed[(currentIndex + 1) % allowed.length];
  return next?.level;
}

export function buildUnavailableProvidersRows(view: ModelAccessRootView): SettingsRow[] {
  if (view.unavailableProviders.length === 0) {
    return [{ id: "emptyUnavailable", kind: "note", label: "No saved unavailable providers" }];
  }
  return view.unavailableProviders.map(({ provider, routingEnabled, ruleTypes }) => ({
    id: `provider:${provider}`,
    kind: "category",
    label: provider,
    detail: [
      `Routing ${routingEnabled ? "ON" : "OFF"}`,
      ...(ruleTypes.length > 0
        ? [`${ruleTypes.length} saved Agent rule${ruleTypes.length === 1 ? "" : "s"}`]
        : []),
    ].join(" · "),
  }));
}

export function buildUnavailableProviderRows(
  entry: ModelAccessUnavailableProvider,
): SettingsRow[] {
  const rows: SettingsRow[] = [{
    id: "routing",
    kind: "toggle",
    label: entry.provider,
    value: entry.routingEnabled ? "ON" : "OFF",
  }];
  if (entry.ruleTypes.length > 0) {
    rows.push({
      id: "deleteRules",
      kind: "action",
      label: "Delete saved access rules...",
      value: String(entry.ruleTypes.length),
      choices: ["Delete"],
      confirm: [
        `Delete all saved access rules for ${entry.provider}?`,
        "",
        ...entry.ruleTypes.map((type) => `- Agent: ${type}`),
      ].join("\n"),
    });
  }
  return rows;
}
