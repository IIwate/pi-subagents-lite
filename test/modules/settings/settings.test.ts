import { describe, expect, it } from "vitest";
import {
  createSettings,
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
  let failUpdatesWith = options.failUpdatesWith;
  const updates: Array<{ id: string; value: boolean }> = [];
  const spawnUpdates: Array<{ id: string; value: boolean | number }> = [];
  const promptUpdates: Array<{ id: string; value: boolean | string }> = [];
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
  const settings = createSettings({
    summaries: { read: () => ({ ...summaries }) },
    display,
    spawn,
    prompt,
  });
  return {
    settings,
    summaries,
    view,
    spawnView,
    promptView,
    updates,
    spawnUpdates,
    promptUpdates,
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
    const result = expectOk(settings.execute({ kind: "select", id: "debug" }));
    expect(result.effect).toEqual({ kind: "open-legacy-category", category: "debug" });
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
