import { describe, expect, it } from "vitest";
import {
  createSettings,
  type DisplaySettingsOwner,
  type DisplaySettingsView,
  type RootSummaries,
} from "../../../src/modules/settings/public.js";

interface HarnessOptions {
  summaries?: Partial<RootSummaries>;
  display?: Partial<DisplaySettingsView>;
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
  let failUpdatesWith = options.failUpdatesWith;
  const updates: Array<{ id: string; value: boolean }> = [];
  const display: DisplaySettingsOwner = {
    read: () => ({ ...view }),
    update(id, value) {
      if (failUpdatesWith) return { ok: false, message: failUpdatesWith };
      updates.push({ id, value });
      view[id] = value;
      return { ok: true };
    },
  };
  const settings = createSettings({
    summaries: { read: () => ({ ...summaries }) },
    display,
  });
  return {
    settings,
    summaries,
    view,
    updates,
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
