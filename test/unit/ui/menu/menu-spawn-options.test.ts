/**
 * menu-spawn-options.test.ts — Tests for showSpawnOptionsMenu.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * SettingsList maintains internal cursor state (fixes cursor position reset).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetMenuStore } from "../../../support/menu-mocks.js";
import { createMockCtx } from "../../../support/menu-helpers.js";

// Capture SettingsList constructor calls from pi-tui
let settingsListCalls: Array<{
  items: any[];
  maxVisible: number;
  theme: any;
  onChange: (id: string, newValue: string) => void;
  onCancel: () => void;
  options?: any;
}> = [];

let inputInstances: Array<{
  value: string;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  setValue: (v: string) => void;
  getValue: () => string;
}> = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    items: any[];
    constructor(items: any[], maxVisible: number, theme: any, onChange: any, onCancel: any, options?: any) {
      this.items = items;
      settingsListCalls.push({ items, maxVisible, theme, onChange, onCancel, options });
    }
  },
  Input: class MockInput {
    value = "";
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    setValue(v: string) { this.value = v; }
    getValue() { return this.value; }
    constructor() {
      inputInstances.push(this as any);
    }
  },
}));

// Import AFTER mock setup
import { showSpawnOptionsMenu } from "../../../../src/ui/menu/menu-spawn-options.js";

describe("showSpawnOptionsMenu — SettingsList integration", () => {
  beforeEach(() => {
    resetMenuStore({ agent: { forceBackground: false } });
    vi.clearAllMocks();
    settingsListCalls = [];
    inputInstances = [];
  });

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });
});

describe("showSpawnOptionsMenu — force background", () => {
  beforeEach(() => {
    resetMenuStore({ agent: { forceBackground: false } });
    vi.clearAllMocks();
    settingsListCalls = [];
    inputInstances = [];
  });

  it("shows 'Force background · OFF' when disabled", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const fb = settingsListCalls[0].items.find((i: any) => i.id === "forceBackground");
    expect(fb.currentValue).toBe("OFF");
  });

  it("shows 'Force background · ON' when enabled", async () => {
    resetMenuStore({ agent: { forceBackground: true } });
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const fb = settingsListCalls[0].items.find((i: any) => i.id === "forceBackground");
    expect(fb.currentValue).toBe("ON");
  });

  it("toggles force background via onChange", async () => {
    const { store } = resetMenuStore({ agent: { forceBackground: false } });
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    settingsListCalls[0].onChange("forceBackground", "ON");
    expect(store.agent.forceBackground).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });
});

describe("showSpawnOptionsMenu — background delivery", () => {
  beforeEach(() => {
    resetMenuStore({ agent: { forceBackground: false } });
    vi.clearAllMocks();
    settingsListCalls = [];
    inputInstances = [];
  });

  it("does not expose a background delivery policy", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const delivery = settingsListCalls[0].items.find((item: any) => item.id === "backgroundDelivery");
    expect(delivery).toBeUndefined();
  });
});

describe("showSpawnOptionsMenu — grace turns", () => {
  beforeEach(() => {
    resetMenuStore({ agent: { forceBackground: false } });
    vi.clearAllMocks();
    settingsListCalls = [];
    inputInstances = [];
  });

  it("shows 'Grace turns · 6' with default value", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const gt = settingsListCalls[0].items.find((i: any) => i.id === "graceTurns");
    expect(gt.currentValue).toBe("6");
    expect(typeof gt.submenu).toBe("function");
  });

  it("shows configured grace turns value", async () => {
    resetMenuStore({ agent: { forceBackground: false, graceTurns: 10 } });
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const gt = settingsListCalls[0].items.find((i: any) => i.id === "graceTurns");
    expect(gt.currentValue).toBe("10");
  });

  it("grace turns submenu creates Input and handles valid submit", async () => {
    const { store } = resetMenuStore({ agent: { forceBackground: false, graceTurns: 5 } });
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const gt = settingsListCalls[0].items.find((i: any) => i.id === "graceTurns");
    const mockDone = vi.fn();
    gt.submenu("5", mockDone);

    expect(inputInstances.length).toBe(1);
    expect(inputInstances[0].value).toBe("5");

    inputInstances[0].onSubmit!("0");
    expect(store.agent.graceTurns).toBe(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    expect(mockDone).toHaveBeenCalledWith("0");
  });

  it("grace turns submenu rejects negative numbers", async () => {
    const { store } = resetMenuStore({ agent: { forceBackground: false, graceTurns: 3 } });
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const gt = settingsListCalls[0].items.find((i: any) => i.id === "graceTurns");
    const mockDone = vi.fn();
    gt.submenu("3", mockDone);

    inputInstances[0].onSubmit!("-1");
    expect(store.agent.graceTurns).toBe(3);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });

  it("grace turns submenu handles escape", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const gt = settingsListCalls[0].items.find((i: any) => i.id === "graceTurns");
    const mockDone = vi.fn();
    gt.submenu("6", mockDone);

    inputInstances[0].onEscape!();
    expect(mockDone).toHaveBeenCalled();
  });
});

describe("showSpawnOptionsMenu — default thinking level", () => {
  beforeEach(() => {
    resetMenuStore({ agent: { forceBackground: false } });
    vi.clearAllMocks();
    settingsListCalls = [];
    inputInstances = [];
  });

  it("shows 'Default thinking level · inherit' when no default is set", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const dt = settingsListCalls[0].items.find((i: any) => i.id === "defaultThinking");
    expect(dt.currentValue).toBe("inherit");
  });

  it("shows configured thinking level", async () => {
    resetMenuStore({ agent: { forceBackground: false, defaultThinking: "high" } });
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const dt = settingsListCalls[0].items.find((i: any) => i.id === "defaultThinking");
    expect(dt.currentValue).toBe("high");
  });

  it("offers max thinking level", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const dt = settingsListCalls[0].items.find((i: any) => i.id === "defaultThinking");
    expect(dt.values).toContain("max");
  });

  it("sets thinking level via onChange", async () => {
    const { store } = resetMenuStore({ agent: { forceBackground: false } });
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    settingsListCalls[0].onChange("defaultThinking", "medium");
    expect(store.agent.defaultThinking).toBe("medium");
    settingsListCalls[0].onChange("defaultThinking", "inherit");
    expect(store.agent.defaultThinking).toBeUndefined();
  });
});

describe("showSpawnOptionsMenu — Disable default agents", () => {
  beforeEach(() => {
    resetMenuStore({ agent: { forceBackground: false } });
    vi.clearAllMocks();
    settingsListCalls = [];
    inputInstances = [];
  });

  it("shows 'Disable default agents · OFF' by default", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const dda = settingsListCalls[0].items.find((i: any) => i.id === "disableDefaultAgents");
    expect(dda.currentValue).toBe("OFF");
  });

  it("shows 'Disable default agents · ON' when disableDefaultAgents is true", async () => {
    resetMenuStore({ agent: { forceBackground: false, disableDefaultAgents: true } });
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const dda = settingsListCalls[0].items.find((i: any) => i.id === "disableDefaultAgents");
    expect(dda.currentValue).toBe("ON");
  });

  it("toggles disable default agents via onChange", async () => {
    const { store } = resetMenuStore({ agent: { forceBackground: false, disableDefaultAgents: false } });
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    settingsListCalls[0].onChange("disableDefaultAgents", "ON");
    expect(store.agent.disableDefaultAgents).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });
});
