/** Display settings menu tests. */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";

let settingsListCalls: Array<{
  items: any[];
  maxVisible: number;
  theme: any;
  onChange: (id: string, newValue: string) => void;
  onCancel: () => void;
  options?: any;
}> = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    items: any[];
    constructor(items: any[], maxVisible: number, theme: any, onChange: any, onCancel: any, options?: any) {
      this.items = items;
      settingsListCalls.push({ items, maxVisible, theme, onChange, onCancel, options });
    }
  },
}));

import { showWidgetSettingsMenu } from "../../../src/ui/menu/menu-widget-settings.js";

function resetMocks(): void {
  mockModules.mockConfig.agent = {
    forceBackground: false,
    expandListByDefault: true,
    showTools: true,
    showTurns: true,
    showInput: true,
    showOutput: true,
    showContext: true,
    showCost: false,
    showTime: true,
  };
  vi.clearAllMocks();
  settingsListCalls = [];
}

describe("showWidgetSettingsMenu", () => {
  beforeEach(resetMocks);

  it("uses one native settings list", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    expect(ctx.ui.custom).toHaveBeenCalledOnce();
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(settingsListCalls).toHaveLength(1);
    expect(settingsListCalls[0].items.map(item => item.id)).toEqual([
      "expandListByDefault",
      "showTools",
      "showTurns",
      "showInput",
      "showOutput",
      "showContext",
      "showCost",
      "showTime",
    ]);
  });

  it("shows current ON/OFF values", async () => {
    mockModules.mockConfig.agent.expandListByDefault = false;
    mockModules.mockConfig.agent.showTurns = false;
    mockModules.mockConfig.agent.showCost = false;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const items = settingsListCalls[0].items;
    expect(items.find(item => item.id === "expandListByDefault").currentValue).toBe("OFF");
    expect(items.find(item => item.id === "showTools").currentValue).toBe("ON");
    expect(items.find(item => item.id === "showTurns").currentValue).toBe("OFF");
    expect(items.find(item => item.id === "showCost").currentValue).toBe("OFF");
  });

  it("tells the user to reload after changing the list default", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    settingsListCalls[0].onChange("expandListByDefault", "OFF");

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Expand list by default OFF · /reload to apply now",
      "info",
    );
  });

  it("updates every display setting", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const { onChange } = settingsListCalls[0];

    for (const id of [
      "expandListByDefault",
      "showTools",
      "showTurns",
      "showInput",
      "showOutput",
      "showContext",
      "showTime",
    ]) {
      onChange(id, "OFF");
      expect(mockModules.mockConfig.agent[id]).toBe(false);
    }
    onChange("showCost", "ON");
    expect(mockModules.mockConfig.agent.showCost).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(8);
  });
});
