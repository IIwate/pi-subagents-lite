import { describe, expect, it } from "vitest";
import {
  createSettings,
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
  type PromptSettingsOwner,
  type PromptSettingsView,
  type RootSummaries,
  type SpawnSettingsOwner,
  type SpawnSettingsView,
} from "../../../src/modules/settings/public.js";

interface HarnessOptions {
  summaries?: Partial<RootSummaries>;
  display?: Partial<DisplaySettingsView>;
  spawn?: Partial<SpawnSettingsView>;
  prompt?: Partial<PromptSettingsView>;
  concurrency?: Partial<ConcurrencySettingsView>;
  debugTypes?: DebugAgentType[];
  debugDiagnostics?: DebugDiagnosticsView;
  debugUnavailableWith?: string;
  failUpdatesWith?: string;
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
  const display: DisplaySettingsOwner = {
    read: () => ({ ...view }),
    update(id, value) {
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
  const settings = createSettings({
    summaries: { read: () => ({ ...summaries }) },
    display,
    spawn,
    prompt,
    concurrency,
    debug,
  });
  return {
    settings,
    summaries,
    view,
    spawnView,
    promptView,
    concurrencyView,
    debugState,
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

  it("delegates an un-migrated category to its legacy menu and stays on the root", () => {
    const { settings } = harness();
    settings.execute({ kind: "open" });
    const result = expectOk(settings.execute({ kind: "select", id: "model-access" }));
    expect(result.effect).toEqual({ kind: "open-legacy-category", category: "model-access" });
    expect(result.snapshot.page).toBe("root");
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

describe("REQ-SETTINGS-003 spawn options page", () => {
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

describe("REQ-SETTINGS-004 system prompt page", () => {
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

describe("REQ-SETTINGS-005 concurrency page", () => {
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
});
