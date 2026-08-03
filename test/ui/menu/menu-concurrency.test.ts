import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockModules,
  resetSelectDialogInstances,
  selectDialogInstances,
} from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";

let settingsListCalls: any[] = [];
let inputInstances: any[] = [];
let selectListInstances: any[] = [];
let wrapperCalls: any[] = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    items: any[];
    filteredItems: any[];
    selectedIndex = 0;
    submenuComponent: any = null;
    onChange: any;
    onCancel: any;
    constructor(items: any[], _max: number, _theme: any, onChange: any, onCancel: any) {
      this.items = items;
      this.filteredItems = items;
      this.onChange = onChange;
      this.onCancel = onCancel;
      settingsListCalls.push(this);
    }
    render() { return []; }
    handleInput() {}
  },
  SelectList: class MockSelectList {
    items: any[];
    onSelect?: (item: any) => void;
    onCancel?: () => void;
    constructor(items: any[]) {
      this.items = items;
      selectListInstances.push(this);
    }
    render() { return []; }
    handleInput() {}
  },
  Input: class MockInput {
    value = "";
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    constructor() { inputInstances.push(this); }
    setValue(value: string) { this.value = value; }
    getValue() { return this.value; }
  },
}));

vi.mock("../../../src/ui/menu/wrappers/settings-list.js", () => ({
  SettingsListWrapper: class MockSettingsListWrapper {
    constructor(component: any, options: any) {
      wrapperCalls.push({ component, options });
      options.onRebuild?.((items: any[]) => {
        component.items = items;
        component.filteredItems = items;
        component.selectedIndex = 0;
        component.submenuComponent = null;
      });
    }
    render() { return []; }
    handleInput() {}
    invalidate() {}
  },
}));

import { showConcurrencySettingsMenu } from "../../../src/ui/menu/menu-concurrency.js";

function resetState(): void {
  mockModules.mockConfig.modelRouting = { enabled: false, enabledProviders: [], agentAccess: {} };
  mockModules.mockConfig.concurrency = { default: 4 };
  mockModules.mockManager.listAgents.mockReturnValue([]);
  settingsListCalls = [];
  inputInstances = [];
  selectListInstances = [];
  wrapperCalls = [];
  resetSelectDialogInstances();
  vi.clearAllMocks();
}

function items(): any[] {
  return settingsListCalls[0].items;
}

describe("showConcurrencySettingsMenu", () => {
  beforeEach(resetState);

  it("shows a pruned default menu without empty sections or reset noise", async () => {
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx);

    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(wrapperCalls[0].options.title).toBe("Concurrency");
    expect(items().map((item) => item.id)).toEqual([
      "defaultConcurrency",
      "addProviderLimit",
      "addModelLimit",
    ]);
    expect(items()[0]).toMatchObject({
      label: "Fallback model limit",
      currentValue: "4 slots · Default",
    });
  });

  it("shows a custom fallback without calling it Default and restores Default at four", async () => {
    mockModules.mockConfig.concurrency = { default: 8 };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx);
    expect(items().find((item) => item.id === "defaultConcurrency").currentValue).toBe("8 slots");
    expect(items().map((item) => item.id)).toContain("resetAll");

    resetState();
    await showConcurrencySettingsMenu(createMockCtx());
    expect(items().find((item) => item.id === "defaultConcurrency").currentValue).toBe("4 slots · Default");
  });

  it("shows active Provider and Model overrides without section separators", async () => {
    mockModules.mockConfig.concurrency = {
      default: 4,
      providers: { anthropic: 2 },
      models: { "anthropic/claude-sonnet-4-20250514": 1 },
    };
    await showConcurrencySettingsMenu(createMockCtx());

    expect(items().find((item) => item.id === "provider:anthropic")).toMatchObject({
      label: "Provider · anthropic",
      currentValue: "2 slots",
    });
    expect(items().find((item) => item.id === "model:anthropic/claude-sonnet-4-20250514")).toMatchObject({
      label: "Model · anthropic/claude-sonnet-4-20250514",
      currentValue: "1 slot",
    });
    expect(items().some((item) => item.id === "__sep__")).toBe(false);
  });

  it("preserves inactive limits behind one conditional management row", async () => {
    mockModules.mockConfig.concurrency = {
      default: 4,
      providers: { openai: 2 },
      models: { "openai/gpt-4o": 1 },
    };
    await showConcurrencySettingsMenu(createMockCtx());

    expect(items().find((item) => item.id === "provider:openai")).toBeUndefined();
    expect(items().find((item) => item.id === "model:openai/gpt-4o")).toBeUndefined();
    expect(items().find((item) => item.id === "inactiveLimits").currentValue).toBe("2");
    expect(mockModules.mockConfig.concurrency).toMatchObject({
      providers: { openai: 2 },
      models: { "openai/gpt-4o": 1 },
    });
  });

  it("restores dormant limits when Model routing makes them actionable again", async () => {
    mockModules.mockConfig.modelRouting = {
      enabled: true,
      enabledProviders: ["openai"],
      agentAccess: {
        "general-purpose": { providers: { openai: { models: ["gpt-4o"] } } },
      },
    };
    mockModules.mockConfig.concurrency = {
      default: 4,
      providers: { openai: 2 },
      models: { "openai/gpt-4o": 1 },
    };
    await showConcurrencySettingsMenu(createMockCtx());

    expect(items().map((item) => item.id)).toContain("provider:openai");
    expect(items().map((item) => item.id)).toContain("model:openai/gpt-4o");
    expect(items().find((item) => item.id === "inactiveLimits")).toBeUndefined();
  });

  it("keeps accepted-session models actionable after routing changes", async () => {
    mockModules.mockConfig.concurrency = {
      default: 4,
      models: { "google/gemini-2.5-pro": 2 },
    };
    mockModules.mockManager.listAgents.mockReturnValue([
      { execution: { modelKey: "google/gemini-2.5-pro" }, lifecycle: { status: "completed" } },
    ] as any);
    await showConcurrencySettingsMenu(createMockCtx());

    expect(items().map((item) => item.id)).toContain("model:google/gemini-2.5-pro");
  });

  it("filters Add Model choices to currently actionable models", async () => {
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx);
    const add = items().find((item) => item.id === "addModelLimit");
    add.submenu("", vi.fn());

    expect(selectDialogInstances.at(-1)?.items.map((item: any) => item.value)).toEqual([
      "anthropic/claude-sonnet-4-20250514",
    ]);
  });

  it("edits and removes an active override", async () => {
    mockModules.mockConfig.concurrency = { default: 4, providers: { anthropic: 2 } };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx);
    const row = items().find((item) => item.id === "provider:anthropic");
    const done = vi.fn();
    row.submenu("2 slots", done);
    let editList = selectListInstances.at(-1)!;
    editList.onSelect!({ value: "edit" });
    inputInstances.at(-1)!.onSubmit!("5");
    expect(mockModules.mockConfig.concurrency.providers!.anthropic).toBe(5);

    row.submenu("5 slots", done);
    editList = selectListInstances.at(-1)!;
    editList.onSelect!({ value: "remove" });
    expect(mockModules.mockConfig.concurrency.providers!.anthropic).toBeUndefined();
    await Promise.resolve();
    expect(settingsListCalls[0].items.some((item: any) => item.id === "provider:anthropic")).toBe(false);
    expect(settingsListCalls[0].selectedIndex).toBe(0);
  });

  it("shows Reset only for non-default state and clears active and inactive limits", async () => {
    mockModules.mockConfig.concurrency = {
      default: 8,
      providers: { anthropic: 2, openai: 3 },
      models: { "openai/gpt-4o": 1 },
    };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx);
    const reset = items().find((item) => item.id === "resetAll");
    reset.submenu("", vi.fn());
    selectListInstances.at(-1)!.onSelect!({ value: "Yes" });

    expect(mockModules.mockConfig.concurrency).toEqual({ default: 4 });
  });
});
