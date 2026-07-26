/**
 * menu-widget-settings.test.ts — 显示设置菜单测试。
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * 菜单只含 thinkingBuffer 与 usageStats（widget 树设置已随树状渲染移除）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { getAgentConfig } from "../../../src/agents/agent-types.js";

// Capture SettingsList constructor calls from pi-tui
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

// Import AFTER mock setup
import { showWidgetSettingsMenu } from "../../../src/ui/menu/menu-widget-settings.js";

function resetMocks(): void {
  mockModules.mockConfig.agent = {
    default: null, forceBackground: false,
    showTools: true, showTurns: true, showInput: true, showOutput: true,
    showContext: true, showCost: false, showTime: true,
  };
  mockModules.mockSessionOverrides.default = null;
  mockModules.mockSessionShowCost = undefined;
  vi.clearAllMocks();
  settingsListCalls = [];
  (getAgentConfig as any).mockImplementation(() => undefined);
}

describe("showWidgetSettingsMenu — SettingsList integration", () => {
  beforeEach(resetMocks);

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("不再提供已移除的 widget 树设置项", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).not.toContain("compact");
    expect(ids).not.toContain("shortcut");
    expect(ids).not.toContain("maxLines");
    expect(ids).not.toContain("maxLinesCompact");
    expect(ids).not.toContain("descLengthFull");
    expect(ids).not.toContain("descLengthCompact");
    expect(ids).toContain("thinkingBuffer");
    expect(ids).toContain("usageStats");
  });
});

describe("showWidgetSettingsMenu — Usage stats submenu", () => {
  beforeEach(resetMocks);

  it("usageStats item has submenu function", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const usageStats = settingsListCalls[0].items.find((i: any) => i.id === "usageStats");
    expect(typeof usageStats.submenu).toBe("function");
  });

  it("stat items have correct ON/OFF values from store", async () => {
    mockModules.mockConfig.agent.showTools = true;
    mockModules.mockConfig.agent.showTurns = false;
    mockModules.mockConfig.agent.showCost = false;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const usageStats = settingsListCalls[0].items.find((i: any) => i.id === "usageStats");
    usageStats.submenu("", vi.fn());

    const statItems = settingsListCalls[1].items;
    expect(statItems.find((i: any) => i.id === "showTools").currentValue).toBe("ON");
    expect(statItems.find((i: any) => i.id === "showTurns").currentValue).toBe("OFF");
    expect(statItems.find((i: any) => i.id === "showCost").currentValue).toBe("OFF");
  });

  it("stat toggle onChange updates store", async () => {
    mockModules.mockConfig.agent.showTools = true;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const usageStats = settingsListCalls[0].items.find((i: any) => i.id === "usageStats");
    usageStats.submenu("", vi.fn());

    settingsListCalls[1].onChange("showTools", "OFF");
    expect(mockModules.mockConfig.agent.showTools).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });

  it("stat toggle onChange for all 7 stats", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const usageStats = settingsListCalls[0].items.find((i: any) => i.id === "usageStats");
    usageStats.submenu("", vi.fn());

    settingsListCalls[1].onChange("showTools", "OFF");
    expect(mockModules.mockConfig.agent.showTools).toBe(false);

    settingsListCalls[1].onChange("showTurns", "OFF");
    expect(mockModules.mockConfig.agent.showTurns).toBe(false);

    settingsListCalls[1].onChange("showInput", "OFF");
    expect(mockModules.mockConfig.agent.showInput).toBe(false);

    settingsListCalls[1].onChange("showOutput", "OFF");
    expect(mockModules.mockConfig.agent.showOutput).toBe(false);

    settingsListCalls[1].onChange("showContext", "OFF");
    expect(mockModules.mockConfig.agent.showContext).toBe(false);

    settingsListCalls[1].onChange("showCost", "ON");
    expect(mockModules.mockConfig.agent.showCost).toBe(true);

    settingsListCalls[1].onChange("showTime", "OFF");
    expect(mockModules.mockConfig.agent.showTime).toBe(false);
  });
});

describe("showWidgetSettingsMenu — thinking buffer", () => {
  beforeEach(() => {
    resetMocks();
    mockModules.mockConfig.agent.outputThinkingBufferSize = 0;
  });

  it("has thinkingBuffer item with ring values", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "thinkingBuffer");
    expect(item).toBeDefined();
  });

  it("shows OFF when outputThinkingBufferSize is 0", async () => {
    mockModules.mockConfig.agent.outputThinkingBufferSize = 0;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "thinkingBuffer");
    expect(item.currentValue).toBe("OFF");
  });

  it("shows number when outputThinkingBufferSize is nonzero", async () => {
    mockModules.mockConfig.agent.outputThinkingBufferSize = 200;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "thinkingBuffer");
    expect(item.currentValue).toBe("200");
  });

  it("onChange updates store with numeric value", async () => {
    mockModules.mockConfig.agent.outputThinkingBufferSize = 0;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("thinkingBuffer", "500");
    expect(mockModules.mockConfig.agent.outputThinkingBufferSize).toBe(500);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });

  it("onChange OFF sets value to 0", async () => {
    mockModules.mockConfig.agent.outputThinkingBufferSize = 200;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("thinkingBuffer", "OFF");
    expect(mockModules.mockConfig.agent.outputThinkingBufferSize).toBe(0);
  });
});
