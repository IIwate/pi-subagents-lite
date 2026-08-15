// Importing ConfigSectionIO evaluates the process-scoped document; pin HOME
// first so that load cannot read the developer's real settings file.
await vi.hoisted(async () => {
  const { mkdtempSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const home = mkdtempSync(path.join(tmpdir(), "settings-persist-home-"));
  mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  process.env.HOME = home;
  // Windows homedir() reads USERPROFILE; Pi's getAgentDir derives from it.
  process.env.USERPROFILE = home;
});

import { describe, expect, it, vi } from "vitest";
import { Check } from "typebox/value";
import { createAgentSettingsStore } from "../../../src/bootstrap/agent-settings.js";
import { createConfigurationSectionIO } from "../../../src/bootstrap/configuration.js";
import { createConfiguration } from "../../../src/modules/configuration/public.js";
import { SystemPromptModeSchema } from "../../../src/modules/prompt/public.js";
import {
  AgentStatusSchema,
  ConcurrencyLimitsUpdateSchema,
  DebugFaultKindSchema,
} from "../../../src/modules/subagent-runtime/public.js";
import {
  ConcurrencyLimitUpdateSchema,
  createSettings,
  DebugFaultSchema,
  DebugStatusPreviewSchema,
  RootSummariesSchema,
  SettingsResultSchema,
  SettingsUpdateResultSchema,
  SYSTEM_PROMPT_MODES,
  type ConcurrencyLimitUpdate,
  type ConcurrencySettingsOwner,
  type ConcurrencySettingsView,
  type DebugAgentType,
  type DebugDiagnosticsView,
  type DebugFault,
  type DebugSettingsOwner,
  type DebugStatusPreview,
  type DisplaySettingsOwner,
  type DisplaySettingsView,
  type ModelAccessAgentRow,
  type ModelAccessSettingsOwner,
  type ModelAccessUnavailableProvider,
  type ModelAccessUnavailableRule,
  type PromptSettingsOwner,
  type PromptSettingsView,
  type RootSummaries,
  type SpawnSettingsOwner,
  type SpawnSettingsView,
} from "../../../src/modules/settings/public.js";

interface ModelAccessFakeOptions {
  enabled?: boolean;
  parentModelKey?: string;
  /** Off-contract rows are injectable here: owners are replaceable ports. */
  agentRows?: ModelAccessAgentRow[];
  providers?: Array<{ provider: string; enabled: boolean }>;
  unavailableProviders?: ModelAccessUnavailableProvider[];
  unavailableRules?: ModelAccessUnavailableRule[];
  thinkingLevels?: Array<{ level: string; allowed: boolean; isDefault: boolean }>;
}

interface HarnessOptions {
  summaries?: Partial<RootSummaries>;
  display?: Partial<DisplaySettingsView>;
  spawn?: Partial<SpawnSettingsView>;
  prompt?: Partial<PromptSettingsView>;
  concurrency?: Partial<ConcurrencySettingsView>;
  debugTypes?: DebugAgentType[];
  debugDiagnostics?: DebugDiagnosticsView;
  debugUnavailableWith?: string;
  modelAccess?: ModelAccessFakeOptions;
  failUpdatesWith?: string;
  /** Off-contract owner write: owners are replaceable ports. */
  corruptWrite?: unknown;
  /** Replace the in-memory display owner with a real persist path. */
  displayOwner?: DisplaySettingsOwner;
}

function harness(options: HarnessOptions = {}) {
  const summaries: RootSummaries = {
    modelAccessEnabled: false,
    concurrencyDefault: 4,
    ...options.summaries,
  };
  const view: DisplaySettingsView = {
    expandListByDefault: true,
    showTools: true,
    showTurns: true,
    showInput: true,
    showOutput: true,
    showContext: true,
    showCost: false,
    showTime: true,
    ...options.display,
  };
  const spawnView: SpawnSettingsView = {
    forceBackground: false,
    graceTurns: 6,
    graceTurnsFallback: 6,
    disableDefaultAgents: false,
    ...options.spawn,
  };
  const promptView: PromptSettingsView = {
    systemPromptMode: "replace",
    includeContextFiles: true,
    loadSkillsImplicitly: true,
    loadExtensionsImplicitly: true,
    customPromptPath: "/home/user/.pi/agent/subagent-prompt.md",
    customPromptFileExists: false,
    ...options.prompt,
  };
  const concurrencyView: ConcurrencySettingsView = {
    defaultLimit: 4,
    factoryDefaultLimit: 4,
    providerLimits: {},
    modelLimits: {},
    activeProviders: ["anthropic", "openai"],
    activeModels: ["anthropic/opus", "openai/gpt-5"],
    ...options.concurrency,
  };
  let failUpdatesWith = options.failUpdatesWith;
  const updates: Array<{ id: string; value: boolean }> = [];
  const spawnUpdates: Array<{ id: string; value: boolean | number }> = [];
  const promptUpdates: Array<{ id: string; value: boolean | string }> = [];
  const concurrencyUpdates: ConcurrencyLimitUpdate[] = [];
  const display: DisplaySettingsOwner = options.displayOwner ?? {
    read: () => ({ ...view }),
    update(id, value) {
      if (options.corruptWrite !== undefined) return options.corruptWrite as never;
      if (failUpdatesWith) return { ok: false, message: failUpdatesWith };
      updates.push({ id, value });
      view[id] = value;
      return { ok: true };
    },
  };
  const spawn: SpawnSettingsOwner = {
    read: () => ({ ...spawnView }),
    update(update) {
      if (failUpdatesWith) return { ok: false, message: failUpdatesWith };
      spawnUpdates.push(update);
      (spawnView as Record<string, boolean | number>)[update.id] = update.value;
      return { ok: true };
    },
  };
  const prompt: PromptSettingsOwner = {
    read: () => ({ ...promptView }),
    update(update) {
      if (failUpdatesWith) return { ok: false, message: failUpdatesWith };
      promptUpdates.push(update);
      (promptView as Record<string, boolean | string>)[update.id] = update.value;
      return { ok: true };
    },
    createCustomPromptFile() {
      if (failUpdatesWith) return { ok: false, message: failUpdatesWith };
      promptView.customPromptFileExists = true;
      return { ok: true };
    },
  };
  const concurrency: ConcurrencySettingsOwner = {
    read: () => structuredClone(concurrencyView),
    update(update) {
      if (failUpdatesWith) return { ok: false, message: failUpdatesWith };
      concurrencyUpdates.push(update);
      if (update.scope === "default") concurrencyView.defaultLimit = update.limit;
      else if (update.scope === "reset") {
        concurrencyView.defaultLimit = concurrencyView.factoryDefaultLimit;
        concurrencyView.providerLimits = {};
        concurrencyView.modelLimits = {};
      } else {
        const section = update.scope === "provider" ? "providerLimits" : "modelLimits";
        if (update.limit === null) delete concurrencyView[section][update.key];
        else concurrencyView[section][update.key] = update.limit;
      }
      return { ok: true };
    },
  };
  const debugState = {
    armedFault: undefined as DebugFault | undefined,
    previews: [] as Array<DebugStatusPreview | null>,
  };
  const debug: DebugSettingsOwner = {
    read: () => (debugState.armedFault ? { armedFault: debugState.armedFault } : {}),
    agentTypes: () => structuredClone(options.debugTypes ?? []),
    diagnostics() {
      if (options.debugUnavailableWith) return { ok: false, message: options.debugUnavailableWith };
      return { ok: true, diagnostics: structuredClone(options.debugDiagnostics ?? { agents: [] }) };
    },
    setStatusPreview(preview) {
      if (options.corruptWrite !== undefined) return options.corruptWrite as never;
      if (options.debugUnavailableWith) return { ok: false, message: options.debugUnavailableWith };
      debugState.previews.push(preview);
      return { ok: true };
    },
    armFault(fault) {
      if (options.debugUnavailableWith) return { ok: false, message: options.debugUnavailableWith };
      debugState.armedFault = fault ?? undefined;
      return { ok: true };
    },
  };
  // Stateful policy fake: mutation verbs record their invocation and apply the
  // obvious state transition so rebuilt snapshots reflect the change. Policy
  // legality itself is the model-access module's contract, not this suite's.
  const modelAccessState = {
    enabled: options.modelAccess?.enabled ?? false,
    parentModelKey: options.modelAccess?.parentModelKey ?? "anthropic/opus",
    providers: options.modelAccess?.providers
      ?? [{ provider: "openai", enabled: true }, { provider: "google", enabled: false }],
    unavailableProviders: structuredClone(options.modelAccess?.unavailableProviders ?? []),
    unavailableRules: structuredClone(options.modelAccess?.unavailableRules ?? []),
    parentAllowed: true,
    allModels: false,
    models: [{ id: "gpt-5", granted: true }, { id: "gpt-5-mini", granted: false }],
    thinkingLevels: structuredClone(options.modelAccess?.thinkingLevels ?? [
      { level: "low", allowed: true, isDefault: true },
      { level: "high", allowed: true, isDefault: false },
      { level: "max", allowed: false, isDefault: false },
    ]),
    calls: [] as string[],
  };
  const policyUpdate = (call: string, apply: () => void): { ok: true } | { ok: false; message: string } => {
    if (failUpdatesWith) return { ok: false, message: failUpdatesWith };
    modelAccessState.calls.push(call);
    apply();
    return { ok: true };
  };
  const modelAccess: ModelAccessSettingsOwner = {
    root: () => ({
      enabled: modelAccessState.enabled,
      parentModelKey: modelAccessState.parentModelKey,
      enabledProviderCount: modelAccessState.providers.filter((entry) => entry.enabled).length,
      configuredAgentCount: 1,
      unavailableProviders: structuredClone(modelAccessState.unavailableProviders),
      unavailableRules: structuredClone(modelAccessState.unavailableRules),
    }),
    agents: () => structuredClone(options.modelAccess?.agentRows ?? [
      { type: "general-purpose", registered: true, summary: "Parent only" },
      { type: "retired-type", registered: false, summary: "1 provider" },
    ]),
    quickAgents: () => [{ type: "general-purpose", registered: true, summary: "Parent only" }],
    agentDetail: () => ({
      parentModelKey: modelAccessState.parentModelKey,
      parentAllowed: modelAccessState.parentAllowed,
      parentDefaultLevel: "high",
      providers: modelAccessState.enabled
        ? modelAccessState.providers.filter((entry) => entry.enabled).map((entry) => entry.provider)
        : [],
      thinkingTargetCount: 2,
    }),
    providers: () => ({
      parentModelKey: modelAccessState.parentModelKey,
      providers: structuredClone(modelAccessState.providers),
    }),
    models: () => ({
      parentModelKey: modelAccessState.parentModelKey,
      allModels: modelAccessState.allModels,
      models: structuredClone(modelAccessState.models),
    }),
    thinkingTargets: () => [
      { key: modelAccessState.parentModelKey, parent: true },
      { key: "openai/gpt-5", parent: false },
    ],
    thinking: () => ({ levels: structuredClone(modelAccessState.thinkingLevels) }),
    setEnabled: (enabled) => policyUpdate(`setEnabled:${enabled}`, () => {
      modelAccessState.enabled = enabled;
    }),
    setProviderEnabled: (provider, enabled) => policyUpdate(`setProviderEnabled:${provider}:${enabled}`, () => {
      const entry = modelAccessState.providers.find((candidate) => candidate.provider === provider);
      if (entry) entry.enabled = enabled;
      const unavailable = modelAccessState.unavailableProviders.find((candidate) => candidate.provider === provider);
      if (unavailable) unavailable.routingEnabled = enabled;
    }),
    setParentAccess: (type, allowed) => policyUpdate(`setParentAccess:${type}:${allowed}`, () => {
      modelAccessState.parentAllowed = allowed;
    }),
    toggleAllModels: (type, provider, quick) => policyUpdate(`toggleAllModels:${type}:${provider}:${quick}`, () => {
      modelAccessState.allModels = !modelAccessState.allModels;
    }),
    toggleModel: (type, provider, modelId, quick) => policyUpdate(`toggleModel:${type}:${provider}:${modelId}:${quick}`, () => {
      const entry = modelAccessState.models.find((candidate) => candidate.id === modelId);
      if (entry) entry.granted = !entry.granted;
    }),
    toggleThinkingLevel: (type, modelKey, level) => policyUpdate(`toggleThinkingLevel:${type}:${modelKey}:${level}`, () => {
      const entry = modelAccessState.thinkingLevels.find((candidate) => candidate.level === level);
      if (entry) entry.allowed = !entry.allowed;
    }),
    setThinkingDefault: (type, modelKey, level) => policyUpdate(`setThinkingDefault:${type}:${modelKey}:${level}`, () => {
      for (const entry of modelAccessState.thinkingLevels) entry.isDefault = entry.level === level;
    }),
    resetThinking: (type, modelKey) => policyUpdate(`resetThinking:${type}:${modelKey}`, () => {}),
    deleteProviderRules: (provider) => policyUpdate(`deleteProviderRules:${provider}`, () => {
      const entry = modelAccessState.unavailableProviders.find((candidate) => candidate.provider === provider);
      if (entry) entry.ruleTypes = [];
    }),
    cleanUnavailableRules: () => policyUpdate("cleanUnavailableRules", () => {
      modelAccessState.unavailableRules = [];
    }),
    clearAll: () => policyUpdate("clearAll", () => {
      modelAccessState.enabled = false;
      modelAccessState.providers = modelAccessState.providers.map((entry) => ({ ...entry, enabled: false }));
    }),
  };
  const settings = createSettings({
    summaries: { read: () => ({ ...summaries }) },
    display,
    spawn,
    prompt,
    concurrency,
    debug,
    modelAccess,
  });
  return {
    settings,
    summaries,
    view,
    spawnView,
    promptView,
    concurrencyView,
    debugState,
    modelAccessState,
    updates,
    spawnUpdates,
    promptUpdates,
    concurrencyUpdates,
    setFailure: (message: string | undefined) => { failUpdatesWith = message; },
  };
}

function expectOk(result: ReturnType<ReturnType<typeof harness>["settings"]["execute"]>) {
  if (!result.ok) throw new Error(`expected ok result, got ${result.error.code}: ${result.error.message}`);
  return result;
}

describe("REQ-SETTINGS-001 settings root workflow", () => {
  it("opens the root menu with all six categories and live effective summaries", () => {
    const { settings } = harness({ summaries: { modelAccessEnabled: true, concurrencyDefault: 8 } });
    const result = expectOk(settings.execute({ kind: "open" }));
    expect(result.snapshot.page).toBe("root");
    expect(result.snapshot.presentation).toBe("menu");
    expect(result.snapshot.rows.map((row) => row.id)).toEqual([
      "model-access",
      "concurrency",
      "spawn-options",
      "system-prompt",
      "display",
      "debug",
    ]);
    expect(result.snapshot.rows[0]!.detail).toBe("Alternates ON · Provider and Agent access");
    expect(result.snapshot.rows[1]!.detail).toBe("8 slots per model");
  });

  it("summarizes disabled model access as Parent-only without calling it Default", () => {
    const { settings } = harness();
    const result = expectOk(settings.execute({ kind: "open" }));
    expect(result.snapshot.rows[0]!.detail).toBe("Alternates OFF · Parent access only");
    expect(result.snapshot.rows[1]!.detail).toBe("4 slots per model");
    expect(result.snapshot.rows[1]!.detail).not.toContain("Default");
  });

  it("closes from the root and returns to the root from a category", () => {
    const { settings } = harness();
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "display" });
    const backToRoot = expectOk(settings.execute({ kind: "back" }));
    expect(backToRoot.snapshot.page).toBe("root");
    expect(backToRoot.effect).toBeUndefined();
    const closed = expectOk(settings.execute({ kind: "back" }));
    expect(closed.effect).toEqual({ kind: "close" });
  });

  it("opens every category as a native settings page without effects", () => {
    const { settings } = harness();
    settings.execute({ kind: "open" });
    const result = expectOk(settings.execute({ kind: "select", id: "model-access" }));
    expect(result.effect).toBeUndefined();
    expect(result.snapshot.page).toBe("model-access");
    expect(result.snapshot.presentation).toBe("menu");
  });

  it("rejects commands outside the schema and unknown categories", () => {
    const { settings } = harness();
    settings.execute({ kind: "open" });
    const invalid = settings.execute({ kind: "explode" });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid-command" } });
    const unknown = settings.execute({ kind: "select", id: "nonexistent" });
    expect(unknown).toMatchObject({ ok: false, error: { code: "unknown-row" } });
  });
});

describe("REQ-SETTINGS-002 display page delegation", () => {
  it("renders the display form from the owner's current values", () => {
    const { settings } = harness({ display: { showTurns: false, showCost: true } });
    settings.execute({ kind: "open" });
    const result = expectOk(settings.execute({ kind: "select", id: "display" }));
    expect(result.snapshot.page).toBe("display");
    expect(result.snapshot.presentation).toBe("form");
    expect(result.snapshot.rows.map((row) => row.id)).toEqual([
      "expandListByDefault",
      "showTools",
      "showTurns",
      "showInput",
      "showOutput",
      "showContext",
      "showCost",
      "showTime",
    ]);
    const byId = new Map(result.snapshot.rows.map((row) => [row.id, row]));
    expect(byId.get("showTurns")!.value).toBe("OFF");
    expect(byId.get("showCost")!.value).toBe("ON");
    expect(byId.get("showTools")!.choices).toEqual(["ON", "OFF"]);
  });

  it("commits a toggle through the owner and reports the new value", () => {
    const { settings, updates } = harness();
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "display" });
    const result = expectOk(settings.execute({ kind: "set-value", id: "showTools", value: "OFF" }));
    expect(updates).toEqual([{ id: "showTools", value: false }]);
    expect(result.snapshot.notice).toEqual({ severity: "info", message: "Show tools OFF" });
    expect(result.snapshot.rows.find((row) => row.id === "showTools")!.value).toBe("OFF");
  });

  it("tells the user to reload after changing the list default", () => {
    const { settings } = harness();
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "display" });
    const result = expectOk(settings.execute({ kind: "set-value", id: "expandListByDefault", value: "OFF" }));
    expect(result.snapshot.notice!.message).toBe("Expand list by default OFF · /reload to apply now");
  });

  it("rejects a value outside the toggle contract", () => {
    const { settings } = harness();
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "display" });
    const result = settings.execute({ kind: "set-value", id: "showTools", value: "MAYBE" });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-value" } });
  });
});

describe("REQ-SETTINGS-002 spawn options page", () => {
  it("renders toggles and the numeric grace-turns row from the owner's values", () => {
    const { settings } = harness({ spawn: { forceBackground: true, graceTurns: 9 } });
    settings.execute({ kind: "open" });
    const result = expectOk(settings.execute({ kind: "select", id: "spawn-options" }));
    expect(result.snapshot.page).toBe("spawn-options");
    expect(result.snapshot.presentation).toBe("form");
    expect(result.snapshot.rows.map((row) => row.id)).toEqual([
      "forceBackground",
      "graceTurns",
      "disableDefaultAgents",
    ]);
    const byId = new Map(result.snapshot.rows.map((row) => [row.id, row]));
    expect(byId.get("forceBackground")!.value).toBe("ON");
    const grace = byId.get("graceTurns")!;
    expect(grace.kind).toBe("numeric");
    expect(grace.value).toBe("9");
    expect(grace.min).toBe(0);
    expect(grace.fallback).toBe(6);
  });

  it("commits toggles and integer grace turns through the owner", () => {
    const { settings, spawnUpdates } = harness();
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "spawn-options" });
    const toggled = expectOk(settings.execute({ kind: "set-value", id: "forceBackground", value: "ON" }));
    expect(toggled.snapshot.notice).toEqual({ severity: "info", message: "Force background set to ON" });
    const grace = expectOk(settings.execute({ kind: "set-value", id: "graceTurns", value: "0" }));
    expect(grace.snapshot.notice).toEqual({ severity: "info", message: "Grace turns set to 0" });
    expect(grace.snapshot.rows.find((row) => row.id === "graceTurns")!.value).toBe("0");
    expect(spawnUpdates).toEqual([
      { id: "forceBackground", value: true },
      { id: "graceTurns", value: 0 },
    ]);
  });

  it("REQ-SETTINGS-003 applies a successful mutation only through the settings workflow owner", () => {
    const { settings, spawnUpdates, spawnView } = harness();
    expect(spawnView.forceBackground).toBe(false);
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "spawn-options" });
    expectOk(settings.execute({ kind: "set-value", id: "forceBackground", value: "ON" }));
    expect(spawnUpdates).toEqual([{ id: "forceBackground", value: true }]);
    expect(spawnView.forceBackground).toBe(true);
    settings.execute({ kind: "back" });
    settings.execute({ kind: "back" });
    const again = expectOk(settings.execute({ kind: "select", id: "spawn-options" }));
    expect(again.snapshot.rows.find((row) => row.id === "forceBackground")!.value).toBe("ON");
  });

  it("reports disable-default-agents changes with availability wording", () => {
    const { settings } = harness();
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "spawn-options" });
    const disabled = expectOk(settings.execute({ kind: "set-value", id: "disableDefaultAgents", value: "ON" }));
    expect(disabled.snapshot.notice).toEqual({ severity: "info", message: "Default agents disabled" });
    const enabled = expectOk(settings.execute({ kind: "set-value", id: "disableDefaultAgents", value: "OFF" }));
    expect(enabled.snapshot.notice).toEqual({ severity: "info", message: "Default agents enabled" });
  });

  it("rejects non-integer and negative grace turns without calling the owner", () => {
    const { settings, spawnUpdates } = harness();
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "spawn-options" });
    for (const value of ["abc", "1.5", "-1", ""]) {
      const result = settings.execute({ kind: "set-value", id: "graceTurns", value });
      expect(result).toMatchObject({ ok: false, error: { code: "invalid-value" } });
    }
    expect(spawnUpdates).toEqual([]);
  });

  it("keeps the previous value and reports an explicit notice when the commit fails", () => {
    const { settings, spawnView } = harness({ failUpdatesWith: "disk full" });
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "spawn-options" });
    const result = expectOk(settings.execute({ kind: "set-value", id: "graceTurns", value: "9" }));
    expect(result.snapshot.notice).toEqual({
      severity: "error",
      message: "Failed to save setting: disk full",
    });
    expect(result.snapshot.rows.find((row) => row.id === "graceTurns")!.value).toBe("6");
    expect(spawnView.graceTurns).toBe(6);
  });
});

describe("REQ-SETTINGS-002 system prompt page", () => {
  it("renders the mode choice and hides the create action outside custom mode", () => {
    const { settings } = harness();
    settings.execute({ kind: "open" });
    const result = expectOk(settings.execute({ kind: "select", id: "system-prompt" }));
    expect(result.snapshot.page).toBe("system-prompt");
    expect(result.snapshot.rows.map((row) => row.id)).toEqual([
      "systemPromptMode",
      "includeContextFiles",
      "loadSkillsImplicitly",
      "loadExtensionsImplicitly",
    ]);
    const mode = result.snapshot.rows[0]!;
    expect(mode.kind).toBe("choice");
    expect(mode.choices).toEqual(["replace", "inherit", "custom"]);
  });

  it("offers the create action only in custom mode while the file is missing", () => {
    const { settings, promptView } = harness();
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "system-prompt" });
    const custom = expectOk(settings.execute({ kind: "set-value", id: "systemPromptMode", value: "custom" }));
    expect(custom.snapshot.notice).toEqual({ severity: "info", message: "System prompt mode set to custom" });
    const action = custom.snapshot.rows.find((row) => row.id === "createPromptFile");
    expect(action).toMatchObject({ kind: "action", choices: ["Create"] });
    expect(action!.detail).toContain(promptView.customPromptPath);

    const created = expectOk(settings.execute({ kind: "set-value", id: "createPromptFile", value: "Create" }));
    expect(created.snapshot.notice).toEqual({
      severity: "info",
      message: `Created prompt file: ${promptView.customPromptPath}`,
    });
    // File now exists, so the action disappears from the rebuilt snapshot.
    expect(created.snapshot.rows.some((row) => row.id === "createPromptFile")).toBe(false);
  });

  it("reports an explicit failure when the prompt file cannot be created", () => {
    const { settings, setFailure } = harness();
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "system-prompt" });
    settings.execute({ kind: "set-value", id: "systemPromptMode", value: "custom" });
    setFailure("EACCES: permission denied");
    const result = expectOk(settings.execute({ kind: "set-value", id: "createPromptFile", value: "Create" }));
    expect(result.snapshot.notice).toEqual({
      severity: "error",
      message: "Failed to create prompt file: EACCES: permission denied",
    });
    expect(result.snapshot.rows.some((row) => row.id === "createPromptFile")).toBe(true);
  });

  it("commits prompt toggles through the owner and rejects unknown modes", () => {
    const { settings, promptUpdates } = harness();
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "system-prompt" });
    const toggled = expectOk(settings.execute({ kind: "set-value", id: "loadSkillsImplicitly", value: "OFF" }));
    expect(toggled.snapshot.notice).toEqual({ severity: "info", message: "Load skills implicitly set to OFF" });
    expect(promptUpdates).toEqual([{ id: "loadSkillsImplicitly", value: false }]);

    const invalid = settings.execute({ kind: "set-value", id: "systemPromptMode", value: "yolo" });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid-value" } });
    expect(promptUpdates).toHaveLength(1);
  });
});

describe("REQ-SETTINGS-002 concurrency page", () => {
  it("renders fallback, active overrides, pickers, and the reset action", () => {
    const { settings } = harness({
      concurrency: {
        defaultLimit: 4,
        providerLimits: { anthropic: 2 },
        modelLimits: { "openai/gpt-5": 3 },
      },
    });
    settings.execute({ kind: "open" });
    const result = expectOk(settings.execute({ kind: "select", id: "concurrency" }));
    expect(result.snapshot.page).toBe("concurrency");
    expect(result.snapshot.rows.map((row) => row.id)).toEqual([
      "defaultConcurrency",
      "provider:anthropic",
      "model:openai/gpt-5",
      "addProviderLimit",
      "addModelLimit",
      "resetAll",
    ]);
    const byId = new Map(result.snapshot.rows.map((row) => [row.id, row]));
    expect(byId.get("defaultConcurrency")).toMatchObject({ kind: "numeric", value: "4 slots · Default", input: "4", min: 1 });
    expect(byId.get("provider:anthropic")).toMatchObject({ kind: "limit", value: "2 slots", input: "2" });
    // Only un-limited inventory entries stay addable.
    expect(byId.get("addProviderLimit")!.choices).toEqual(["openai"]);
    expect(byId.get("addModelLimit")!.choices).toEqual(["anthropic/opus"]);
    expect(byId.get("resetAll")).toMatchObject({ kind: "action", confirm: "Reset all concurrency limits?" });
  });

  it("hides pickers and reset in the factory state and drops the Default tag after edits", () => {
    const { settings } = harness({
      concurrency: { activeProviders: [], activeModels: [] },
    });
    settings.execute({ kind: "open" });
    const factory = expectOk(settings.execute({ kind: "select", id: "concurrency" }));
    expect(factory.snapshot.rows.map((row) => row.id)).toEqual(["defaultConcurrency"]);

    const edited = expectOk(settings.execute({ kind: "set-value", id: "defaultConcurrency", value: "9" }));
    expect(edited.snapshot.notice).toEqual({ severity: "info", message: "Fallback model limit set to 9" });
    const fallbackRow = edited.snapshot.rows.find((row) => row.id === "defaultConcurrency")!;
    expect(fallbackRow.value).toBe("9 slots");
    expect(edited.snapshot.rows.some((row) => row.id === "resetAll")).toBe(true);
  });

  it("lists saved inactive limits with an explicit edit/remove path after the pickers", () => {
    const { settings } = harness({
      concurrency: {
        providerLimits: { retiredhost: 2 },
        modelLimits: { "retiredhost/old-model": 1 },
      },
    });
    settings.execute({ kind: "open" });
    const result = expectOk(settings.execute({ kind: "select", id: "concurrency" }));
    // Inactive rows keep the legacy menu ordering: scope name ascending, so
    // Model entries precede Provider entries.
    expect(result.snapshot.rows.map((row) => row.id)).toEqual([
      "defaultConcurrency",
      "addProviderLimit",
      "addModelLimit",
      "model:retiredhost/old-model",
      "provider:retiredhost",
      "resetAll",
    ]);
    const inactive = result.snapshot.rows.find((row) => row.id === "provider:retiredhost")!;
    expect(inactive.label).toBe("Inactive Provider · retiredhost");
    expect(inactive.kind).toBe("limit");
  });

  it("edits and removes keyed limits through update-limit", () => {
    const { settings, concurrencyUpdates } = harness({
      concurrency: { providerLimits: { anthropic: 2 } },
    });
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "concurrency" });
    const edited = expectOk(settings.execute({ kind: "update-limit", id: "provider:anthropic", limit: 5 }));
    expect(edited.snapshot.notice).toEqual({ severity: "info", message: "anthropic concurrency set to 5" });

    const removed = expectOk(settings.execute({ kind: "update-limit", id: "provider:anthropic", limit: null }));
    expect(removed.snapshot.notice).toEqual({ severity: "info", message: "Removed Provider limit for anthropic" });
    expect(removed.snapshot.rows.some((row) => row.id === "provider:anthropic")).toBe(false);
    expect(concurrencyUpdates).toEqual([
      { scope: "provider", key: "anthropic", limit: 5 },
      { scope: "provider", key: "anthropic", limit: null },
    ]);
  });

  it("adds a limit for an inventory key and rejects keys outside the inventory", () => {
    const { settings, concurrencyUpdates } = harness();
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "concurrency" });
    const added = expectOk(settings.execute({ kind: "add-limit", id: "addModelLimit", key: "openai/gpt-5", limit: 2 }));
    expect(added.snapshot.notice).toEqual({ severity: "info", message: "openai/gpt-5 concurrency set to 2" });
    expect(added.snapshot.rows.some((row) => row.id === "model:openai/gpt-5")).toBe(true);

    const rejected = settings.execute({ kind: "add-limit", id: "addModelLimit", key: "unknown/model", limit: 2 });
    expect(rejected).toMatchObject({ ok: false, error: { code: "invalid-value" } });
    expect(concurrencyUpdates).toEqual([{ scope: "model", key: "openai/gpt-5", limit: 2 }]);
  });

  it("rejects unknown limit rows, zero limits, and limit commands on other pages", () => {
    const { settings, concurrencyUpdates } = harness();
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "concurrency" });
    const unknown = settings.execute({ kind: "update-limit", id: "provider:ghost", limit: 2 });
    expect(unknown).toMatchObject({ ok: false, error: { code: "unknown-row" } });
    const zero = settings.execute({ kind: "update-limit", id: "provider:anthropic", limit: 0 });
    expect(zero).toMatchObject({ ok: false, error: { code: "invalid-command" } });
    const zeroDefault = settings.execute({ kind: "set-value", id: "defaultConcurrency", value: "0" });
    expect(zeroDefault).toMatchObject({ ok: false, error: { code: "invalid-value" } });

    settings.execute({ kind: "back" });
    settings.execute({ kind: "select", id: "display" });
    const wrongPage = settings.execute({ kind: "update-limit", id: "provider:anthropic", limit: 2 });
    expect(wrongPage).toMatchObject({ ok: false, error: { code: "unknown-row" } });
    expect(concurrencyUpdates).toEqual([]);
  });

  it("resets all limits through the confirmed action row", () => {
    const { settings, concurrencyUpdates } = harness({
      concurrency: { defaultLimit: 9, providerLimits: { anthropic: 2 } },
    });
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "concurrency" });
    const result = expectOk(settings.execute({ kind: "set-value", id: "resetAll", value: "Reset" }));
    expect(result.snapshot.notice).toEqual({ severity: "info", message: "Concurrency reset" });
    expect(result.snapshot.rows.map((row) => row.id)).toEqual([
      "defaultConcurrency",
      "addProviderLimit",
      "addModelLimit",
    ]);
    expect(concurrencyUpdates).toEqual([{ scope: "reset" }]);
  });

  it("keeps the saved limits and reports an explicit notice when the commit fails", () => {
    const { settings, concurrencyView } = harness({
      concurrency: { providerLimits: { anthropic: 2 } },
      failUpdatesWith: "disk full",
    });
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "concurrency" });
    const result = expectOk(settings.execute({ kind: "update-limit", id: "provider:anthropic", limit: 9 }));
    expect(result.snapshot.notice).toEqual({
      severity: "error",
      message: "Failed to save setting: disk full",
    });
    expect(result.snapshot.rows.find((row) => row.id === "provider:anthropic")!.value).toBe("2 slots");
    expect(concurrencyView.providerLimits.anthropic).toBe(2);
  });
});

describe("REQ-RUNTIME-007 debug page", () => {
  it("renders reports, previews, and fault rows with the armed fault marked", () => {
    const { settings } = harness();
    settings.execute({ kind: "open" });
    const opened = expectOk(settings.execute({ kind: "select", id: "debug" }));
    expect(opened.snapshot.page).toBe("debug");
    expect(opened.snapshot.presentation).toBe("form");
    expect(opened.snapshot.rows.map((row) => row.id)).toEqual([
      "agentTypes",
      "runtimeDiagnostics",
      "preview-clear",
      "preview-queued",
      "preview-running",
      "preview-done",
      "preview-turn-limit",
      "preview-aborted",
      "preview-stopped",
      "preview-error",
      "arm-blocked",
      "arm-provider",
      "arm-clear",
    ]);

    const armed = expectOk(settings.execute({ kind: "set-value", id: "arm-blocked", value: "Arm" }));
    expect(armed.snapshot.notice).toEqual({
      severity: "info",
      message: "Armed output_blocked for the next agent",
    });
    expect(armed.snapshot.rows.find((row) => row.id === "arm-blocked")!.label).toBe("Arm: blocked (armed)");
    expect(armed.snapshot.rows.find((row) => row.id === "arm-provider")!.label).toBe("Arm: provider error");

    const cleared = expectOk(settings.execute({ kind: "set-value", id: "arm-clear", value: "Clear" }));
    expect(cleared.snapshot.notice).toEqual({ severity: "info", message: "Cleared armed fault" });
    expect(cleared.snapshot.rows.find((row) => row.id === "arm-blocked")!.label).toBe("Arm: blocked");
  });

  it("formats the agent types report from the owner's structured catalogue", () => {
    const { settings } = harness({
      debugTypes: [
        { name: "general-purpose", description: "General agent", hidden: false },
        { name: "reviewer", description: "Reads diffs", tools: ["Grep", "Read"], source: "user", hidden: true },
      ],
    });
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "debug" });
    const result = expectOk(settings.execute({ kind: "set-value", id: "agentTypes", value: "Show" }));
    const report = result.snapshot.notice!.message;
    expect(result.snapshot.notice!.severity).toBe("info");
    expect(report).toContain("Available agent types:");
    expect(report).toContain("  general-purpose\n    General agent\n  Tools: all built-in tools");
    expect(report).toContain("  reviewer [HIDDEN]\n    Reads diffs\n  Tools: Grep, Read\n  Source: user");
  });

  it("reports an empty catalogue without pretending types exist", () => {
    const { settings } = harness({ debugTypes: [] });
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "debug" });
    const result = expectOk(settings.execute({ kind: "set-value", id: "agentTypes", value: "Show" }));
    expect(result.snapshot.notice).toEqual({ severity: "info", message: "No agent types available" });
  });

  it("formats runtime diagnostics with armed fault, per-agent state, and the empty case", () => {
    const { settings } = harness({
      debugDiagnostics: {
        armedFault: "provider_error",
        agents: [{
          id: "0123456789abcdef",
          type: "Explore",
          status: "running",
          session: "live",
          settled: false,
          resultPersisted: false,
          resultConsumed: false,
          debugFaultKind: "provider_error",
          error: "boom",
        }],
      },
    });
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "debug" });
    const result = expectOk(settings.execute({ kind: "set-value", id: "runtimeDiagnostics", value: "Show" }));
    const report = result.snapshot.notice!.message;
    expect(report).toContain("Armed fault: provider_error · next started Agent");
    expect(report).toContain("01234567 (Explore) running");
    expect(report).toContain("  Session: live · Settled: no · Persisted: no · Consumed: no");
    expect(report).toContain("  Debug fault: provider_error");
    expect(report).toContain("  Error: boom");

    const empty = expectOk(settings.execute({ kind: "set-value", id: "agentTypes", value: "Show" }));
    expect(empty.snapshot.notice!.message).toBe("No agent types available");
  });

  it("applies and clears the UI-only status preview through the owner", () => {
    const { settings, debugState } = harness();
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "debug" });
    const applied = expectOk(settings.execute({ kind: "set-value", id: "preview-turn-limit", value: "Apply" }));
    expect(applied.snapshot.notice).toEqual({ severity: "info", message: "Status preview set to Turn limit" });
    const cleared = expectOk(settings.execute({ kind: "set-value", id: "preview-clear", value: "Apply" }));
    expect(cleared.snapshot.notice).toEqual({ severity: "info", message: "Status preview cleared" });
    expect(debugState.previews).toEqual(["turn_limited", null]);
  });

  it("reports session unavailability as an informational notice, not a save failure", () => {
    const { settings, debugState } = harness({
      debugUnavailableWith: "Agent manager is not available in this session",
    });
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "debug" });
    for (const id of ["runtimeDiagnostics", "preview-queued", "arm-blocked"]) {
      const result = expectOk(settings.execute({ kind: "set-value", id, value: "x" }));
      expect(result.snapshot.notice).toEqual({
        severity: "info",
        message: "Agent manager is not available in this session",
      });
    }
    expect(debugState.previews).toEqual([]);

    const unknown = settings.execute({ kind: "set-value", id: "nonexistent", value: "x" });
    expect(unknown).toMatchObject({ ok: false, error: { code: "unknown-row" } });
  });
});

/**
 * Production agent-section path: ConfigSectionIO.commit returns
 * `{ ok:false, code, message }`, and the store forwards that object.
 */
function persistFailingDisplayOwner(message: string) {
  const io = createConfigurationSectionIO(createConfiguration({
    repository: {
      load: () => ({ status: "loaded" as const, document: { agent: { showTools: true } } }),
      persist() {
        throw new Error(message);
      },
    },
  }));
  const store = createAgentSettingsStore(io, () => null);
  const display: DisplaySettingsOwner = {
    read() {
      const agent = store.read();
      return {
        expandListByDefault: agent.expandListByDefault,
        showTools: agent.showTools,
        showTurns: agent.showTurns,
        showInput: agent.showInput,
        showOutput: agent.showOutput,
        showContext: agent.showContext,
        showCost: agent.showCost,
        showTime: agent.showTime,
      };
    },
    update(id, value) {
      return store.update(id, value);
    },
  };
  return { display, store };
}

describe("REQ-CONFIG-001 explicit persistence failure", () => {
  it("keeps the previous value effective and reports an explicit failure notice", () => {
    const { settings, view } = harness({ failUpdatesWith: "disk full" });
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "display" });
    const result = expectOk(settings.execute({ kind: "set-value", id: "showTools", value: "OFF" }));
    expect(result.snapshot.notice).toEqual({
      severity: "error",
      message: "Failed to save setting: disk full",
    });
    // The snapshot re-reads the owner: the saved value is still ON.
    expect(result.snapshot.rows.find((row) => row.id === "showTools")!.value).toBe("ON");
    expect(view.showTools).toBe(true);
  });

  it("recovers on the next successful commit", () => {
    const { settings, setFailure } = harness({ failUpdatesWith: "disk full" });
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "display" });
    settings.execute({ kind: "set-value", id: "showTools", value: "OFF" });
    setFailure(undefined);
    const result = expectOk(settings.execute({ kind: "set-value", id: "showTools", value: "OFF" }));
    expect(result.snapshot.notice).toEqual({ severity: "info", message: "Show tools OFF" });
    expect(result.snapshot.rows.find((row) => row.id === "showTools")!.value).toBe("OFF");
  });

  it("keeps the display page and shows a save-failure notice when the real owner returns persistence-failure", () => {
    const { display, store } = persistFailingDisplayOwner("disk full");
    let ownerWrite: unknown;
    const { settings } = harness({
      displayOwner: {
        read: () => display.read(),
        update(id, value) {
          ownerWrite = display.update(id, value);
          return ownerWrite as ReturnType<DisplaySettingsOwner["update"]>;
        },
      },
    });
    settings.execute({ kind: "open" });
    const page = expectOk(settings.execute({ kind: "select", id: "display" }));
    expect(page.snapshot.page).toBe("display");

    const result = settings.execute({ kind: "set-value", id: "showTools", value: "OFF" });
    expect(ownerWrite).toEqual({
      ok: false,
      code: "persistence-failure",
      message: "disk full",
    });
    expect(Check(SettingsUpdateResultSchema, ownerWrite)).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        page: "display",
        notice: { severity: "error", message: "Failed to save setting: disk full" },
      },
    });
    expect(result.ok && result.snapshot.notice?.message).not.toMatch(/does not match its contract/);
    expect(result.ok && result.snapshot.rows.find((row) => row.id === "showTools")?.value).toBe("ON");
    expect(store.read().showTools).toBe(true);
    expect(Check(SettingsResultSchema, result)).toBe(true);
  });
});

describe("REQ-MODEL-007 model access pages", () => {
  function openModelAccess(options: HarnessOptions = {}) {
    const h = harness(options);
    h.settings.execute({ kind: "open" });
    h.settings.execute({ kind: "select", id: "model-access" });
    return h;
  }

  it("hides routing-only rows while alternate models are OFF", () => {
    const { settings } = harness();
    settings.execute({ kind: "open" });
    const result = expectOk(settings.execute({ kind: "select", id: "model-access" }));
    expect(result.snapshot.rows.map((row) => row.id)).toEqual([
      "alternateModels",
      "quickSetup",
      "agentAccess",
      "resetAll",
    ]);
    expect(result.snapshot.rows[0]).toMatchObject({ kind: "toggle", value: "OFF" });
  });

  it("shows provider access, unavailable providers, and cleanup once routing is ON", () => {
    const { settings } = harness({
      modelAccess: {
        enabled: true,
        unavailableProviders: [{ provider: "gone", routingEnabled: true, ruleTypes: ["general-purpose"] }],
        unavailableRules: [{ provider: "gone", agentType: "general-purpose", modelId: "old-model" }],
      },
    });
    settings.execute({ kind: "open" });
    const result = expectOk(settings.execute({ kind: "select", id: "model-access" }));
    expect(result.snapshot.rows.map((row) => row.id)).toEqual([
      "alternateModels",
      "quickSetup",
      "providerAccess",
      "agentAccess",
      "unavailableProviders",
      "cleanUnavailableRules",
      "resetAll",
    ]);
    const cleanup = result.snapshot.rows.find((row) => row.id === "cleanUnavailableRules")!;
    expect(cleanup.confirm).toContain("Remove 1 unavailable model access rule?");
    expect(cleanup.confirm).toContain("- Provider: gone");
    expect(cleanup.confirm).toContain("    - Model: old-model");
  });

  it("toggles alternate models through the owner and reports the transition", () => {
    const { settings, modelAccessState } = openModelAccess();
    const result = expectOk(settings.execute({ kind: "select", id: "alternateModels" }));
    expect(modelAccessState.calls).toEqual(["setEnabled:true"]);
    expect(result.snapshot.notice).toEqual({ severity: "info", message: "Alternate models enabled" });
    expect(result.snapshot.rows[0]).toMatchObject({ id: "alternateModels", value: "ON" });
  });

  it("toggles provider routing from the provider access page and skips stale rows", () => {
    const { settings, modelAccessState } = openModelAccess({ modelAccess: { enabled: true } });
    settings.execute({ kind: "select", id: "providerAccess" });
    const toggled = expectOk(settings.execute({ kind: "select", id: "provider:google" }));
    expect(modelAccessState.calls).toEqual(["setProviderEnabled:google:true"]);
    expect(toggled.snapshot.notice).toEqual({ severity: "info", message: "google enabled for routed models" });
    expect(toggled.snapshot.rows.find((row) => row.id === "provider:google")!.label).toBe("[x] google");

    const stale = expectOk(settings.execute({ kind: "select", id: "provider:vanished" }));
    expect(stale.snapshot.page).toBe("model-access/providers");
    expect(modelAccessState.calls).toHaveLength(1);
  });

  it("walks agent access to models and toggles grants through the owner verbs", () => {
    const { settings, modelAccessState } = openModelAccess({ modelAccess: { enabled: true } });
    settings.execute({ kind: "select", id: "agentAccess" });
    const agents = expectOk(settings.execute({ kind: "select", id: "type:general-purpose" }));
    expect(agents.snapshot.page).toBe("model-access/agent");
    expect(agents.snapshot.rows.map((row) => row.id)).toEqual([
      "parentAccess",
      "provider:openai",
      "thinking",
    ]);

    const models = expectOk(settings.execute({ kind: "select", id: "provider:openai" }));
    expect(models.snapshot.page).toBe("model-access/models");
    expect(models.snapshot.rows.map((row) => row.id)).toEqual([
      "parentDefault",
      "all",
      "model:gpt-5",
      "model:gpt-5-mini",
    ]);

    expectOk(settings.execute({ kind: "select", id: "all" }));
    expectOk(settings.execute({ kind: "select", id: "model:gpt-5-mini" }));
    expect(modelAccessState.calls).toEqual([
      "toggleAllModels:general-purpose:openai:false",
      "toggleModel:general-purpose:openai:gpt-5-mini:false",
    ]);

    // Unwind one level per back: models -> agent -> agent list -> model access root.
    expect(expectOk(settings.execute({ kind: "back" })).snapshot.page).toBe("model-access/agent");
    expect(expectOk(settings.execute({ kind: "back" })).snapshot.page).toBe("model-access/agents");
    expect(expectOk(settings.execute({ kind: "back" })).snapshot.page).toBe("model-access");
  });

  it("toggles parent access and blocks it without an active parent model", () => {
    const { settings, modelAccessState } = openModelAccess();
    settings.execute({ kind: "select", id: "agentAccess" });
    settings.execute({ kind: "select", id: "type:general-purpose" });
    const denied = expectOk(settings.execute({ kind: "select", id: "parentAccess" }));
    expect(modelAccessState.calls).toEqual(["setParentAccess:general-purpose:false"]);
    expect(denied.snapshot.notice).toEqual({
      severity: "info",
      message: "Parent model denied for general-purpose",
    });

    modelAccessState.parentModelKey = "";
    const blocked = expectOk(settings.execute({ kind: "select", id: "parentAccess" }));
    expect(blocked.snapshot.notice).toEqual({
      severity: "info",
      message: "Select a parent model before changing Parent model access",
    });
    expect(modelAccessState.calls).toHaveLength(1);
  });

  it("routes quick setup to the parent provider and requires a parent model", () => {
    const { settings } = openModelAccess();
    settings.execute({ kind: "select", id: "quickSetup" });
    const models = expectOk(settings.execute({ kind: "select", id: "type:general-purpose" }));
    expect(models.snapshot.page).toBe("model-access/models");
    expect(models.snapshot.title).toBe("Quick Setup · general-purpose · anthropic");

    const { settings: noParent } = openModelAccess({ modelAccess: { parentModelKey: "" } });
    const refused = expectOk(noParent.execute({ kind: "select", id: "quickSetup" }));
    expect(refused.snapshot.page).toBe("model-access");
    expect(refused.snapshot.notice).toEqual({
      severity: "info",
      message: "Select a parent model before using Quick model setup",
    });
  });

  it("quick setup toggles use the quick transition so routing prerequisites engage", () => {
    const { settings, modelAccessState } = openModelAccess();
    settings.execute({ kind: "select", id: "quickSetup" });
    settings.execute({ kind: "select", id: "type:general-purpose" });
    expectOk(settings.execute({ kind: "select", id: "model:gpt-5" }));
    expect(modelAccessState.calls).toEqual(["toggleModel:general-purpose:anthropic:gpt-5:true"]);
  });

  it("edits thinking policies with a last-allowed-level guard and default cycling", () => {
    const { settings, modelAccessState } = openModelAccess();
    settings.execute({ kind: "select", id: "agentAccess" });
    settings.execute({ kind: "select", id: "type:general-purpose" });
    const targets = expectOk(settings.execute({ kind: "select", id: "thinking" }));
    expect(targets.snapshot.rows.map((row) => row.label)).toEqual([
      "Parent model · anthropic/opus",
      "openai/gpt-5",
    ]);

    const levels = expectOk(settings.execute({ kind: "select", id: "target:openai/gpt-5" }));
    expect(levels.snapshot.rows.map((row) => row.id)).toEqual([
      "level:low",
      "level:high",
      "level:max",
      "default",
      "reset",
    ]);
    expect(levels.snapshot.rows[0]!.label).toBe("[x] low · default");

    expectOk(settings.execute({ kind: "select", id: "level:max" }));
    const cycled = expectOk(settings.execute({ kind: "select", id: "default" }));
    expect(cycled.snapshot.notice).toEqual({ severity: "info", message: "Default thinking level set to high" });
    expectOk(settings.execute({ kind: "select", id: "reset" }));
    expect(modelAccessState.calls).toEqual([
      "toggleThinkingLevel:general-purpose:openai/gpt-5:max",
      "setThinkingDefault:general-purpose:openai/gpt-5:high",
      "resetThinking:general-purpose:openai/gpt-5",
    ]);

    // Disallow high and max again, leaving low as the only allowed level.
    modelAccessState.thinkingLevels = [
      { level: "low", allowed: true, isDefault: true },
      { level: "high", allowed: false, isDefault: false },
    ];
    const guarded = expectOk(settings.execute({ kind: "select", id: "level:low" }));
    expect(guarded.snapshot.notice).toEqual({
      severity: "info",
      message: "At least one thinking level must stay allowed",
    });
    expect(modelAccessState.calls).toHaveLength(3);
  });

  it("refuses a thinking page whose owner copies a non-canonical level", () => {
    const { settings, modelAccessState } = openModelAccess();
    modelAccessState.thinkingLevels = [
      { level: "vendor-ultra", allowed: true, isDefault: true },
    ];
    settings.execute({ kind: "select", id: "agentAccess" });
    settings.execute({ kind: "select", id: "type:general-purpose" });
    settings.execute({ kind: "select", id: "thinking" });
    const result = settings.execute({ kind: "select", id: "target:openai/gpt-5" });
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid-snapshot", message: "Settings page does not match its contract." },
    });
    expect(Check(SettingsResultSchema, result)).toBe(true);
  });

  it("manages saved unavailable providers: routing toggle, rule deletion, and stale unwind", () => {
    const { settings, modelAccessState } = openModelAccess({
      modelAccess: {
        enabled: true,
        unavailableProviders: [{ provider: "gone", routingEnabled: true, ruleTypes: ["general-purpose", "reviewer"] }],
        unavailableRules: [{ provider: "gone", agentType: "general-purpose", modelId: "old-model" }],
      },
    });
    settings.execute({ kind: "select", id: "unavailableProviders" });
    const page = expectOk(settings.execute({ kind: "select", id: "provider:gone" }));
    expect(page.snapshot.page).toBe("model-access/unavailable-provider");
    expect(page.snapshot.rows.map((row) => row.id)).toEqual(["routing", "deleteRules"]);
    expect(page.snapshot.rows[1]!.confirm).toContain("Delete all saved access rules for gone?");
    expect(page.snapshot.rows[1]!.confirm).toContain("- Agent: reviewer");

    const toggled = expectOk(settings.execute({ kind: "select", id: "routing" }));
    expect(toggled.snapshot.notice).toEqual({ severity: "info", message: "gone disabled for routed models" });

    expectOk(settings.execute({ kind: "select", id: "deleteRules" }));
    expect(modelAccessState.calls).toEqual([
      "setProviderEnabled:gone:false",
      "deleteProviderRules:gone",
    ]);

    // All rules are gone now; the page unwinds to the list with a notice
    // instead of rendering a stale management page.
    modelAccessState.unavailableProviders = [];
    const unwound = expectOk(settings.execute({ kind: "select", id: "routing" }));
    expect(unwound.snapshot.page).toBe("model-access/unavailable");
    expect(unwound.snapshot.notice).toEqual({ severity: "info", message: "No saved access rules remain" });
  });

  it("cleans unavailable rules from the root and reports the removed count", () => {
    const { settings, modelAccessState } = openModelAccess({
      modelAccess: {
        enabled: true,
        unavailableRules: [
          { provider: "gone", agentType: "general-purpose", modelId: "old-a" },
          { provider: "gone", agentType: "general-purpose", modelId: "old-b" },
        ],
      },
    });
    const result = expectOk(settings.execute({ kind: "select", id: "cleanUnavailableRules" }));
    expect(modelAccessState.calls).toEqual(["cleanUnavailableRules"]);
    expect(result.snapshot.notice).toEqual({
      severity: "info",
      message: "Removed 2 unavailable model access rules",
    });
    expect(result.snapshot.rows.some((row) => row.id === "cleanUnavailableRules")).toBe(false);
  });

  it("resets all model access policy from the root action", () => {
    const { settings, modelAccessState } = openModelAccess({ modelAccess: { enabled: true } });
    const result = expectOk(settings.execute({ kind: "select", id: "resetAll" }));
    expect(modelAccessState.calls).toEqual(["clearAll"]);
    expect(result.snapshot.notice).toEqual({ severity: "info", message: "Model access reset" });
    expect(result.snapshot.rows[0]).toMatchObject({ id: "alternateModels", value: "OFF" });
  });

  it("surfaces policy commit failures as explicit save errors (REQ-CONFIG-001)", () => {
    const { settings } = openModelAccess({ failUpdatesWith: "disk full" });
    const result = expectOk(settings.execute({ kind: "select", id: "alternateModels" }));
    expect(result.snapshot.notice).toEqual({
      severity: "error",
      message: "Failed to save setting: disk full",
    });
    expect(result.snapshot.rows[0]).toMatchObject({ id: "alternateModels", value: "OFF" });
  });
});

describe("REQ-SETTINGS-005 serializable result contract", () => {
  const walk = [
    { kind: "open" as const },
    { kind: "select" as const, id: "model-access" },
    { kind: "select" as const, id: "agentAccess" },
    { kind: "select" as const, id: "type:general-purpose" },
    { kind: "select" as const, id: "thinking" },
    { kind: "select" as const, id: "target:openai/gpt-5" },
    { kind: "back" as const },
    { kind: "back" as const },
    { kind: "back" as const },
    { kind: "back" as const },
    { kind: "select" as const, id: "concurrency" },
    { kind: "update-limit" as const, id: "default", limit: 3 },
    { kind: "back" as const },
    { kind: "select" as const, id: "spawn-options" },
    { kind: "set-value" as const, id: "graceTurns", value: "9" },
    { kind: "back" as const },
    { kind: "select" as const, id: "system-prompt" },
    { kind: "set-value" as const, id: "systemPromptMode", value: "inherit" },
    { kind: "back" as const },
    { kind: "select" as const, id: "display" },
    { kind: "set-value" as const, id: "showTools", value: "OFF" },
    { kind: "back" as const },
    { kind: "select" as const, id: "debug" },
  ];

  it("returns schema-valid results that survive a JSON round trip on every page", () => {
    const { settings } = harness({ modelAccess: { enabled: true } });
    for (const command of walk) {
      const result = settings.execute(command);
      expect(Check(SettingsResultSchema, result)).toBe(true);
      expect(Check(SettingsResultSchema, JSON.parse(JSON.stringify(result)))).toBe(true);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    }
  });

  it("refuses a page whose owner view violates the row contract", () => {
    // A registry that lost an agent name: the row would render as a
    // selectable entry with no label.
    const { settings } = harness({
      modelAccess: {
        enabled: true,
        agentRows: [{ type: "", registered: true, summary: "broken" }],
      },
    });
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "model-access" });
    const result = settings.execute({ kind: "select", id: "agentAccess" });
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid-snapshot", message: "Settings page does not match its contract." },
    });
    expect(Check(SettingsResultSchema, result)).toBe(true);
  });

  it("rejects an off-contract owner write instead of treating it as committed", () => {
    const { settings, view } = harness({ corruptWrite: { ok: "yes" } });
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "display" });
    const result = settings.execute({ kind: "set-value", id: "showTools", value: "OFF" });
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid-snapshot", message: "Settings update result does not match its contract." },
    });
    expect(view.showTools).toBe(true);
    expect(Check(SettingsResultSchema, JSON.parse(JSON.stringify(result)))).toBe(true);
  });

  it("rejects an off-contract debug write instead of applying a preview", () => {
    const { settings, debugState } = harness({ corruptWrite: { ok: true, extra: true } });
    settings.execute({ kind: "open" });
    settings.execute({ kind: "select", id: "debug" });
    const result = settings.execute({ kind: "set-value", id: "preview-queued", value: "Apply" });
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid-snapshot", message: "Settings update result does not match its contract." },
    });
    expect(debugState.previews).toEqual([]);
  });
});

describe("embedded owner schemas", () => {
  it("embeds runtime concurrency, status, and fault schemas instead of restating them", () => {
    expect(ConcurrencyLimitUpdateSchema).toBe(ConcurrencyLimitsUpdateSchema);
    expect(DebugFaultSchema).toBe(DebugFaultKindSchema);
    expect(DebugStatusPreviewSchema).toBe(AgentStatusSchema);
  });

  it("requires RootSummaries.concurrencyDefault to be an integer ≥ 1", () => {
    expect(Check(RootSummariesSchema, { modelAccessEnabled: false, concurrencyDefault: 4 })).toBe(true);
    expect(Check(RootSummariesSchema, { modelAccessEnabled: false, concurrencyDefault: 0 })).toBe(false);
    expect(Check(RootSummariesSchema, { modelAccessEnabled: false, concurrencyDefault: 1.5 })).toBe(false);
  });

  it("derives system prompt mode choices from SystemPromptModeSchema", () => {
    expect([...SYSTEM_PROMPT_MODES]).toEqual(["replace", "inherit", "custom"]);
    for (const mode of SYSTEM_PROMPT_MODES) {
      expect(Check(SystemPromptModeSchema, mode)).toBe(true);
    }
    expect(Check(SystemPromptModeSchema, "yolo")).toBe(false);
  });
});
