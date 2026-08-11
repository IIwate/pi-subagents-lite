import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockModules } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { getAllTypes } from "../../../src/agents/agent-types.js";

let settingsLists: any[] = [];
let selectLists: any[] = [];
let wrappers: any[] = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    items: any[];
    onChange: any;
    onCancel: any;
    constructor(items: any[], _max: number, _theme: any, onChange: any, onCancel: any) {
      this.items = items;
      this.onChange = onChange;
      this.onCancel = onCancel;
      settingsLists.push(this);
    }
    render() { return this.items.map((item) => `${item.label}${item.currentValue ? ` ${item.currentValue}` : ""}`); }
    handleInput() {}
    invalidate() {}
    updateValue() {}
  },
  SelectList: class MockSelectList {
    items: any[];
    selectedIndex = 0;
    onSelect?: (item: any) => void;
    onCancel?: () => void;
    constructor(items: any[]) {
      this.items = items;
      selectLists.push(this);
    }
    render() { return this.items.map((item) => item.label); }
    handleInput() {}
    invalidate() {}
  },
  wrapTextWithAnsi: (text: string) => [text],
}));

vi.mock("../../../src/ui/menu/wrappers/settings-list.js", () => ({
  SettingsListWrapper: class MockSettingsListWrapper {
    constructor(component: any, options: any) {
      wrappers.push({ component, options });
      options.onRebuild?.((items: any[]) => { component.items = items; });
    }
    render() { return []; }
    handleInput() {}
    invalidate() {}
  },
}));

import { showModelRoutingMenu } from "../../../src/ui/menu/menu-model-routing.js";

function reset(): void {
  mockModules.mockConfig.modelRouting = { enabled: false, enabledProviders: [], agentAccess: {} };
  mockModules.mockConfig.agent = { forceBackground: false };
  settingsLists = [];
  selectLists = [];
  wrappers = [];
  vi.clearAllMocks();
  (getAllTypes as any).mockReturnValue(["Explore", "reviewer"]);
}

function topItem(id: string): any {
  return settingsLists[0].items.find((item: any) => item.id === id);
}

function lastSelect(): any {
  return selectLists[selectLists.length - 1];
}

function lastSettings(): any {
  return settingsLists[settingsLists.length - 1];
}

function selectLastValue(value: string): void {
  const list = lastSelect();
  const item = list.items.find((candidate: any) => candidate.value === value);
  expect(item).toBeDefined();
  list.onSelect(item);
}

describe("Model Access top level", () => {
  beforeEach(reset);

  it("keeps Parent and Quick access configuration available while alternates are OFF", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    expect(wrappers[0].options.title).toBe("Model Access");
    expect(topItem("alternateModels").currentValue).toBe("OFF");
    expect(topItem("quickSetup")).toBeDefined();
    expect(topItem("agentAccess")).toBeDefined();
    expect(topItem("providerAccess")).toBeUndefined();
  });

  it("toggles alternate models", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    settingsLists[0].onChange("alternateModels", "ON");
    expect(mockModules.mockConfig.modelRouting.enabled).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Alternate models enabled", "info");
  });

  it("shows canonical summaries when ON", async () => {
    mockModules.mockConfig.modelRouting = {
      enabled: true,
      enabledProviders: ["openai", "anthropic"],
      agentAccess: {
        Explore: { providers: { openai: {}, anthropic: { models: ["claude-haiku-4"] } } },
        reviewer: { providers: { openai: { models: ["o3"] } } },
      },
    };
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    expect(topItem("providerAccess").label).toBe("Provider access");
    expect(topItem("providerAccess").currentValue).toBe("2 enabled");
    expect(topItem("agentAccess").currentValue).toBe("2 configured");
    expect(topItem("quickSetup")).toBeDefined();
    expect(topItem("resetAll")).toBeDefined();
  });

  it("clears the complete routing policy", async () => {
    mockModules.mockConfig.modelRouting = {
      enabled: true,
      enabledProviders: ["openai"],
      agentAccess: { Explore: { providers: { openai: {} } } },
    };
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("resetAll").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Yes" });
    expect(mockModules.mockConfig.modelRouting).toEqual({ enabled: false, enabledProviders: [], agentAccess: {} });
  });
});

describe("Provider access", () => {
  beforeEach(() => {
    reset();
    mockModules.mockConfig.modelRouting.enabled = true;
  });

  it("uses only Pi-available providers and includes the current Parent Provider as mutable", async () => {
    const ctx = createMockCtx();
    ctx.modelRegistry.getAll.mockReturnValue([
      ...ctx.modelRegistry.getAll(),
      ...Array.from({ length: 40 }, (_, index) => ({ provider: `builtin-${index}`, id: "default" })),
    ]);
    await showModelRoutingMenu(ctx);
    topItem("providerAccess").submenu("", vi.fn());
    expect(lastSelect().items.filter((item: any) => item.kind === "provider").map((item: any) => item.provider))
      .toEqual(["anthropic", "openai"]);

    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    const agentProviders = lastSelect().items
      .filter((item: any) => item.kind === "provider")
      .map((item: any) => item.value);
    expect(agentProviders).toEqual([]);
  });

  it("shows an informational Parent default and direct Provider checkboxes", async () => {
    mockModules.mockConfig.modelRouting.enabledProviders = ["anthropic"];
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("providerAccess").submenu("", vi.fn());
    const rows = lastSelect().items;
    expect(rows[0].label).toContain("Parent default · anthropic/claude-sonnet-4-20250514");
    expect(rows[0].nonSelectable).toBe(true);
    expect(rows.filter((row: any) => row.kind === "separator")).toHaveLength(1);
    expect(rows.some((row: any) => row.label.includes("Available providers"))).toBe(false);
    expect(rows.map((row: any) => row.description).join(" ")).not.toMatch(/availability|effective|saved Agent rules|\b0\b/i);
    expect(rows.find((row: any) => row.provider === "anthropic").label).toBe("[x] anthropic");
    expect(rows.find((row: any) => row.provider === "openai").label).toBe("[ ] openai");
  });

  it("toggles in place and preserves the cursor on the Provider", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("providerAccess").submenu("", vi.fn());
    const openai = lastSelect().items.find((row: any) => row.provider === "openai");
    lastSelect().onSelect(openai);
    expect(mockModules.mockConfig.modelRouting.enabledProviders).toEqual(["openai"]);
    expect(lastSelect().items.find((row: any) => row.provider === "openai").label).toBe("[x] openai");
    expect(lastSelect().selectedIndex).toBe(
      lastSelect().items.findIndex((row: any) => row.provider === "openai"),
    );
    expect(settingsLists).toHaveLength(1);
    expect(topItem("providerAccess").currentValue).toBe("1 enabled");

    lastSelect().onSelect(lastSelect().items.find((row: any) => row.provider === "openai"));
    expect(mockModules.mockConfig.modelRouting.enabledProviders).toEqual([]);
    expect(lastSelect().selectedIndex).toBe(
      lastSelect().items.findIndex((row: any) => row.provider === "openai"),
    );
  });

  it("toggles the selected Provider with Space", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("providerAccess").submenu("", vi.fn());
    const list = lastSelect();
    list.selectedIndex = list.items.findIndex((row: any) => row.provider === "openai");
    list.handleInput(" ");
    expect(mockModules.mockConfig.modelRouting.enabledProviders).toEqual(["openai"]);
    expect(lastSelect().selectedIndex).toBe(
      lastSelect().items.findIndex((row: any) => row.provider === "openai"),
    );
  });

  it("refreshes availability and the catalogue when the submenu opens", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    ctx.modelRegistry.getAvailable.mockReturnValue([
      { provider: "anthropic", id: "claude-haiku-4" },
      { provider: "late-provider", id: "worker" },
    ]);
    topItem("providerAccess").submenu("", vi.fn());
    expect(lastSelect().items.filter((item: any) => item.kind === "provider").map((item: any) => item.provider))
      .toEqual(["anthropic", "late-provider"]);
    expect(ctx.modelRegistry.getAvailable).toHaveBeenCalledTimes(2);
    expect(ctx.modelRegistry.getAll).toHaveBeenCalledTimes(2);
  });

  it("keeps the current Parent Provider as an ordinary mutable alternate Provider", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("providerAccess").submenu("", vi.fn());
    const openai = lastSelect().items.find((row: any) => row.provider === "openai");
    ctx.model = { provider: "openai", id: "gpt-4o" };
    lastSelect().onSelect(openai);
    expect(mockModules.mockConfig.modelRouting.enabledProviders).toEqual(["openai"]);
    expect(lastSelect().items.filter((row: any) => row.kind === "provider").map((row: any) => row.provider))
      .toEqual(["anthropic", "openai"]);
  });

  it("counts the current Parent Provider when its alternate access is enabled", async () => {
    mockModules.mockConfig.modelRouting.enabledProviders = ["anthropic", "openai", "google"];
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    expect(topItem("providerAccess").currentValue).toBe("2 enabled");
    topItem("providerAccess").submenu("", vi.fn());
    expect(lastSelect().items.filter((row: any) => row.kind === "provider").map((row: any) => row.provider))
      .toEqual(["anthropic", "openai"]);
  });

  it("toggles prototype-like Provider IDs without confusing control rows", async () => {
    const ctx = createMockCtx();
    ctx.modelRegistry.getAvailable.mockReturnValue([
      ...ctx.modelRegistry.getAvailable(),
      { provider: "constructor", id: "worker" },
      { provider: "__proto__", id: "worker" },
    ]);
    await showModelRoutingMenu(ctx);
    topItem("providerAccess").submenu("", vi.fn());
    const prototypeRow = lastSelect().items.find((row: any) => row.provider === "__proto__");
    expect(prototypeRow.kind).toBe("provider");
    lastSelect().onSelect(prototypeRow);
    expect(mockModules.mockConfig.modelRouting.enabledProviders).toContain("__proto__");
  });

  it("still exposes the current Parent Provider when it is the only available Provider", async () => {
    const ctx = createMockCtx();
    ctx.modelRegistry.getAvailable.mockReturnValue([
      { provider: "anthropic", id: "claude-sonnet-4-20250514" },
    ]);
    await showModelRoutingMenu(ctx);
    topItem("providerAccess").submenu("", vi.fn());
    expect(lastSelect().items.filter((row: any) => row.kind === "provider").map((row: any) => row.provider))
      .toEqual(["anthropic"]);
  });

  it("keeps the unavailable Parent default form when no parent is active", async () => {
    const ctx = createMockCtx();
    ctx.model = undefined;
    ctx.modelRegistry.getAvailable.mockReturnValue([]);
    await showModelRoutingMenu(ctx);
    topItem("providerAccess").submenu("", vi.fn());
    expect(lastSelect().items[0].label).toContain("Parent default · No active parent model");
    expect(lastSelect().items[0].description).toContain("Unavailable");
  });
});

describe("Quick model setup", () => {
  beforeEach(() => {
    reset();
    mockModules.mockConfig.modelRouting.enabled = true;
  });

  it("starts with a locked Default row and one separator", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("quickSetup").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    const rows = lastSelect().items;
    expect(rows[0].value).toBe("__default__");
    expect(rows[0].label).toContain("Parent default · anthropic/claude-sonnet-4-20250514");
    expect(rows[1].value).toBe("__separator__");
    expect(rows[1].label).toMatch(/^─+$/);
    expect(rows[2].value).toBe("__all__");
    expect(rows[2].label).toContain("All models");
    expect(rows[2].description).toBe("");
    expect(rows.some((row: any) => row.value === "claude-sonnet-4-20250514")).toBe(false);
    expect(rows.some((row: any) => row.description === "Use exact model rules")).toBe(false);
    expect(rows.some((row: any) => row.value === "__apply__")).toBe(false);
  });

  it("writes current-provider exact access immediately and enables canonical routing state", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("quickSetup").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    mockModules.mockConfig.modelRouting.enabled = false;
    selectLastValue("claude-haiku-4");
    expect(mockModules.mockConfig.modelRouting).toEqual({
      enabled: true,
      enabledProviders: ["anthropic"],
      agentAccess: { Explore: { providers: { anthropic: { models: ["claude-haiku-4"] } } } },
    });
    expect(lastSelect().items[lastSelect().selectedIndex].value).toBe("claude-haiku-4");
  });

  it("uses the canonical all-model rule", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("quickSetup").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    selectLastValue("__all__");
    expect(mockModules.mockConfig.modelRouting.agentAccess.Explore.providers.anthropic).toEqual({});
  });

  it("snapshots current models before removing the first model from All models", async () => {
    const ctx = createMockCtx();
    ctx.modelRegistry.getAll.mockReturnValue([
      ...ctx.modelRegistry.getAll(),
      { provider: "anthropic", id: "claude-opus-4" },
    ]);
    ctx.modelRegistry.getAvailable.mockReturnValue([
      ...ctx.modelRegistry.getAvailable(),
      { provider: "anthropic", id: "claude-opus-4" },
    ]);
    await showModelRoutingMenu(ctx);
    topItem("quickSetup").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    selectLastValue("__all__");
    selectLastValue("claude-haiku-4");
    expect(mockModules.mockConfig.modelRouting.agentAccess.Explore.providers.anthropic)
      .toEqual({ models: ["claude-opus-4"] });
  });

  it("closes Quick setup safely without an active parent model", async () => {
    const ctx = createMockCtx();
    const done = vi.fn();
    ctx.model = undefined;
    await showModelRoutingMenu(ctx);
    const placeholder = topItem("quickSetup").submenu("", done);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Select a parent model before using Quick model setup",
      "warning",
    );
    expect(placeholder.items[0].label).toContain("Parent model unavailable");
    expect(done).toHaveBeenCalledOnce();
  });

  it("removes the provider rule when no alternates are selected", async () => {
    mockModules.mockConfig.modelRouting.agentAccess = {
      Explore: { providers: { anthropic: { models: ["claude-haiku-4"] } } },
    };
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("quickSetup").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    selectLastValue("claude-haiku-4");
    expect(mockModules.mockConfig.modelRouting.agentAccess).toEqual({});
  });
});

describe("Agent model access", () => {
  beforeEach(() => {
    reset();
    mockModules.mockConfig.modelRouting.enabled = true;
    mockModules.mockConfig.modelRouting.enabledProviders = ["openai"];
  });

  it("lists registered and unavailable configured Agent types", async () => {
    mockModules.mockConfig.modelRouting.agentAccess = {
      Explore: { providers: { openai: {} } },
      "ghost-agent": { providers: { google: { models: ["gemini-2.5-pro"] } } },
    };
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    expect(lastSelect().items.find((item: any) => item.value === "Explore").description)
      .toBe("openai (All models)");
    expect(lastSelect().items.find((item: any) => item.value === "reviewer").description).toBe("Parent only");
    expect(lastSelect().items.find((item: any) => item.value === "ghost-agent").label).toContain("agent unavailable");
    expect(lastSelect().items.find((item: any) => item.value === "ghost-agent").description).toBe("Parent only");
  });

  it("formats exact model counts with readable singular and plural labels", async () => {
    mockModules.mockConfig.modelRouting.agentAccess = {
      Explore: { providers: { openai: { models: ["o3"] } } },
      reviewer: { providers: { openai: { models: ["gpt-4o", "o3"] } } },
    };
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    expect(lastSelect().items.find((item: any) => item.value === "Explore").description)
      .toBe("openai (1 model)");
    expect(lastSelect().items.find((item: any) => item.value === "reviewer").description)
      .toBe("openai (2 models)");
  });

  it("shows Parent access separately from explicitly enabled alternate Providers", async () => {
    mockModules.mockConfig.modelRouting.agentAccess = {
      Explore: { providers: { google: { models: ["gemini-2.5-pro"] } } },
    };
    const ctx = createMockCtx();
    ctx.thinkingLevel = "medium";
    ctx.model = { ...ctx.model, reasoning: true };
    ctx.modelRegistry.getAvailable.mockReturnValue([
      ...ctx.modelRegistry.getAvailable(),
      { provider: "cicadas", id: "worker" },
    ]);
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    const rows = lastSelect().items;
    expect(rows[0].kind).toBe("parent");
    expect(rows[0].label).toContain("[x] Use parent model");
    expect(rows[0].label).toContain("medium");
    expect(rows[1].value).toBe("__separator__");
    expect(rows.filter((item: any) => item.kind === "provider").map((item: any) => item.value))
      .toEqual(["openai"]);
    expect(rows.find((item: any) => item.value === "anthropic")).toBeUndefined();
    expect(rows.find((item: any) => item.value === "google")).toBeUndefined();
    expect(rows.find((item: any) => item.value === "cicadas")).toBeUndefined();
  });

  it("does not change alternate Provider access when the parent changes", async () => {
    const ctx = createMockCtx();
    ctx.model = { provider: "openai", id: "gpt-4o", reasoning: true };
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    const providers = lastSelect().items.filter((item: any) => item.kind === "provider");
    expect(providers.map((item: any) => item.value)).toEqual(["openai"]);
    expect(providers[0].label).toBe("openai");
  });

  it("marks Use parent model unavailable when no parent model is active", async () => {
    const ctx = createMockCtx();
    ctx.model = undefined;
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    const parentRow = lastSelect().items[0];
    expect(parentRow.label).toContain("[ ] Use parent model");
    expect(parentRow.description).toContain("Unavailable");
  });

  it("toggles Parent model access independently of Provider rules", async () => {
    const ctx = createMockCtx();
    ctx.thinkingLevel = "medium";
    ctx.model = { ...ctx.model, reasoning: true };
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    const list = lastSelect();
    list.selectedIndex = list.items.findIndex((row: any) => row.kind === "parent");
    list.handleInput(" ");
    expect(mockModules.mockConfig.modelRouting.agentAccess.Explore).toEqual({
      parentModelAccess: false,
      providers: {},
    });
    expect(lastSelect().items.find((row: any) => row.kind === "parent").label)
      .toContain("[ ] Use parent model");
  });

  it("edits and resets an exact Parent-model thinking policy", async () => {
    const ctx = createMockCtx();
    ctx.thinkingLevel = "medium";
    ctx.model = {
      ...ctx.model,
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: null },
    };
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    const parentRow = lastSelect().items.find((row: any) => row.kind === "parent");
    lastSelect().onSelect(parentRow);

    expect(lastSelect().items.find((row: any) => row.value === "medium").label)
      .toContain("default");
    expect(lastSelect().items.find((row: any) => row.value === "max")).toBeUndefined();
    lastSelect().onSelect(lastSelect().items.find((row: any) => row.value === "low"));
    expect(mockModules.mockConfig.modelRouting.agentAccess.Explore.thinking).toEqual({
      "anthropic/claude-sonnet-4-20250514": {
        allowed: ["off", "minimal", "low", "medium", "high", "xhigh"],
        default: "low",
      },
    });

    lastSelect().onSelect(lastSelect().items.find((row: any) => row.value === "__reset__"));
    expect(mockModules.mockConfig.modelRouting.agentAccess).toEqual({});
  });

  it("shows only Parent access while alternate routing is OFF", async () => {
    mockModules.mockConfig.modelRouting.enabled = false;
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    expect(lastSelect().items.some((row: any) => row.kind === "parent")).toBe(true);
    expect(lastSelect().items.some((row: any) => row.kind === "provider")).toBe(false);
  });

  it("refreshes available models when entering the model editor", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    ctx.modelRegistry.getAvailable.mockReturnValue([
      ...ctx.modelRegistry.getAvailable(),
      { provider: "openai", id: "late-model" },
    ]);
    const openai = lastSelect().items.find((row: any) => row.value === "openai");
    lastSelect().onSelect(openai);
    expect(lastSelect().items.find((row: any) => row.value === "late-model")).toBeDefined();
  });

  it("does not inherit a saved rule for a prototype-like Provider ID", async () => {
    mockModules.mockConfig.modelRouting.enabledProviders.push("constructor");
    const ctx = createMockCtx();
    ctx.modelRegistry.getAvailable.mockReturnValue([
      ...ctx.modelRegistry.getAvailable(),
      { provider: "constructor", id: "worker" },
    ]);
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    expect(lastSelect().items.find((row: any) => row.value === "constructor").description).toBe("");
  });

  it("saves exact access immediately without an Apply row", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    lastSelect().onSelect(lastSelect().items.find((row: any) => row.value === "openai"));
    selectLastValue("o3");
    expect(mockModules.mockConfig.modelRouting.agentAccess.Explore.providers.openai)
      .toEqual({ models: ["o3"] });
    expect(lastSelect().items.find((row: any) => row.value === "__apply__")).toBeUndefined();
    expect(lastSelect().items[lastSelect().selectedIndex].value).toBe("o3");
  });

  it("keeps model rows distinct from reserved control values", async () => {
    const ctx = createMockCtx();
    ctx.modelRegistry.getAvailable.mockReturnValue([
      ...ctx.modelRegistry.getAvailable(),
      { provider: "openai", id: "__all__" },
    ]);
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    lastSelect().onSelect(lastSelect().items.find((row: any) => row.value === "openai"));
    const modelRow = lastSelect().items.find((row: any) => row.kind === "model" && row.value === "__all__");
    lastSelect().onSelect(modelRow);
    expect(mockModules.mockConfig.modelRouting.agentAccess.Explore.providers.openai)
      .toEqual({ models: ["__all__"] });
    expect(lastSelect().items[lastSelect().selectedIndex].kind).toBe("model");

    lastSelect().handleInput(" ");
    expect(mockModules.mockConfig.modelRouting.agentAccess).toEqual({});
  });

  it("saves All models immediately and removes access when it is unchecked", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    lastSelect().onSelect(lastSelect().items.find((row: any) => row.value === "openai"));
    selectLastValue("__all__");
    expect(mockModules.mockConfig.modelRouting.agentAccess.Explore.providers.openai).toEqual({});
    selectLastValue("__all__");
    expect(mockModules.mockConfig.modelRouting.agentAccess).toEqual({});
  });

  it("shows only in-scope candidates and preserves hidden dormant exact IDs", async () => {
    mockModules.mockConfig.modelRouting.agentAccess = {
      Explore: { providers: { openai: { models: ["gpt-4o", "o3", "retired"] } } },
    };
    const ctx = createMockCtx();
    ctx.modelRegistry.getAll.mockReturnValue([
      ...ctx.modelRegistry.getAll(),
      { provider: "openai", id: "gpt-4.1" },
    ]);
    ctx.modelRegistry.getAvailable.mockReturnValue([
      ...ctx.modelRegistry.getAvailable(),
      { provider: "openai", id: "gpt-4.1" },
    ]);
    ctx.scopedModels = [
      { model: { provider: "anthropic", id: "claude-sonnet-4-20250514" } },
      { model: { provider: "openai", id: "o3" } },
    ];
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    expect(lastSelect().items.find((row: any) => row.value === "Explore").description)
      .toBe("openai (1 model)");
    lastSelect().onSelect({ value: "Explore" });
    lastSelect().onSelect(lastSelect().items.find((row: any) => row.value === "openai"));
    const rows = lastSelect().items;
    expect(rows.filter((row: any) => row.kind === "model").map((row: any) => row.value))
      .toEqual(["o3"]);
    expect(rows.find((row: any) => row.value === "gpt-4o")).toBeUndefined();
    expect(rows.find((row: any) => row.value === "gpt-4.1")).toBeUndefined();
    expect(rows.find((row: any) => row.value === "retired")).toBeUndefined();
    expect(rows.some((row: any) => row.description === "Out of current scope")).toBe(false);

    selectLastValue("o3");
    expect(mockModules.mockConfig.modelRouting.agentAccess.Explore.providers.openai)
      .toEqual({ models: ["gpt-4o", "retired"] });
  });

  it("uses a concise empty state when the scope has no alternate models", async () => {
    mockModules.mockConfig.modelRouting.enabledProviders = ["anthropic"];
    const ctx = createMockCtx();
    ctx.scopedModels = [{ model: ctx.model }];
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    lastSelect().onSelect(lastSelect().items.find((row: any) => row.value === "anthropic"));
    expect(lastSelect().items.find((row: any) => row.kind === "empty").label)
      .toContain("No alternate models available");
    expect(lastSelect().items.find((row: any) => row.value === "__all__")).toBeUndefined();
    expect(lastSelect().items.find((row: any) => row.value === "__apply__")).toBeUndefined();
  });

  it("hides saved rules for unavailable Providers without deleting them", async () => {
    mockModules.mockConfig.modelRouting.enabledProviders = ["google"];
    mockModules.mockConfig.modelRouting.agentAccess = {
      Explore: { providers: { google: { models: ["gemini-2.5-pro"] } } },
    };
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    expect(lastSelect().items.find((row: any) => row.value === "google")).toBeUndefined();
    expect(mockModules.mockConfig.modelRouting.agentAccess.Explore.providers.google.models)
      .toEqual(["gemini-2.5-pro"]);
  });
});

describe("Saved unavailable providers", () => {
  beforeEach(() => {
    reset();
    mockModules.mockConfig.modelRouting = {
      enabled: true,
      enabledProviders: ["google"],
      agentAccess: {
        Explore: { providers: { google: { models: ["gemini-2.5-pro"] } } },
        "ghost-agent": { providers: { google: {} } },
      },
    };
  });

  it("keeps an unavailable Provider visible even when it becomes the current Parent Provider", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    expect(topItem("savedUnavailableProviders").currentValue).toBe("1");

    ctx.model = { provider: "google", id: "gemini-2.5-pro" };
    settingsLists = [];
    selectLists = [];
    wrappers = [];
    await showModelRoutingMenu(ctx);
    expect(topItem("savedUnavailableProviders").currentValue).toBe("1");
  });

  it("shows only routing and non-zero rule information in the exception flow", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("savedUnavailableProviders").submenu("", vi.fn());
    const google = lastSelect().items.find((row: any) => row.provider === "google");
    expect(google.description).toBe("Routing ON · 2 saved Agent rules");
    expect(google.description).not.toMatch(/availability|effective|\b0\b/i);
    lastSelect().onSelect(google);
    expect(lastSettings().items.map((item: any) => item.id)).toEqual(["routing", "deleteRules"]);
    expect(lastSettings().items.find((item: any) => item.id === "routing")).toMatchObject({
      label: "google",
      currentValue: "ON",
    });
  });

  it("toggles dormant routing without deleting rules and deletes rules only after confirmation", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("savedUnavailableProviders").submenu("", vi.fn());
    lastSelect().onSelect(lastSelect().items.find((row: any) => row.provider === "google"));

    lastSettings().onChange("routing", "OFF");
    expect(mockModules.mockConfig.modelRouting.enabledProviders).toEqual([]);
    expect(mockModules.mockConfig.modelRouting.agentAccess.Explore.providers.google.models)
      .toEqual(["gemini-2.5-pro"]);
    lastSettings().onChange("routing", "ON");

    const remove = lastSettings().items.find((item: any) => item.id === "deleteRules");
    const component = remove.submenu("", vi.fn());
    expect(component.render(100)).toContain("  - Agent: Explore");
    expect(component.render(100)).toContain("  - Agent: ghost-agent");
    lastSelect().onSelect({ value: "Yes" });
    expect(mockModules.mockConfig.modelRouting.agentAccess).toEqual({});
    expect(mockModules.mockConfig.modelRouting.enabledProviders).toEqual(["google"]);
  });

  it("closes a stale delete action after its submenu factory returns", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("savedUnavailableProviders").submenu("", vi.fn());
    lastSelect().onSelect(lastSelect().items.find((row: any) => row.provider === "google"));
    const remove = lastSettings().items.find((item: any) => item.id === "deleteRules");
    mockModules.mockConfig.modelRouting.agentAccess = {};
    const done = vi.fn();
    const component = remove.submenu("", done);
    expect(done).not.toHaveBeenCalled();
    expect(component.render(100)).toContain("No saved access rules remain");
    await Promise.resolve();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("omits zero rule counts and the delete action", async () => {
    mockModules.mockConfig.modelRouting.agentAccess = {};
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("savedUnavailableProviders").submenu("", vi.fn());
    const google = lastSelect().items.find((row: any) => row.provider === "google");
    expect(google.description).toBe("Routing ON");
    expect(google.description).not.toContain("0");
    lastSelect().onSelect(google);
    expect(lastSettings().items.map((item: any) => item.id)).toEqual(["routing"]);
  });

  it("refreshes availability at exception entry instead of using the top snapshot", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    ctx.modelRegistry.getAvailable.mockReturnValue([
      ...ctx.modelRegistry.getAvailable(),
      { provider: "google", id: "gemini-2.5-pro" },
    ]);
    topItem("savedUnavailableProviders").submenu("", vi.fn());
    expect(lastSelect().items).toHaveLength(1);
    expect(lastSelect().items[0].label).toBe("No saved unavailable providers");
  });
});

describe("Global unavailable rule cleanup", () => {
  beforeEach(() => {
    reset();
    mockModules.mockConfig.modelRouting = {
      enabled: true,
      enabledProviders: [],
      agentAccess: {
        Explore: { providers: { openai: { models: ["gpt-4o", "retired"] } } },
        "ghost-agent": { providers: { openai: { models: ["retired"] } } },
        planner: { providers: { openai: {} } },
      },
    };
  });

  it("shows one global action with every affected Provider, Agent, and model ID", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    expect(topItem("cleanUnavailableRules").currentValue).toBe("2");
    const component = topItem("cleanUnavailableRules").submenu("", vi.fn());
    const rendered = component.render(100);
    expect(rendered).toContain("  Remove 2 unavailable model access rules?");
    expect(rendered).toContain("  - Provider: openai");
    expect(rendered).toContain("    - Agent: Explore");
    expect(rendered).toContain("      - Model: retired");
    expect(rendered).toContain("    - Agent: ghost-agent");
    lastSelect().onSelect({ value: "Yes" });
    expect(mockModules.mockConfig.modelRouting.agentAccess).toEqual({
      Explore: { providers: { openai: { models: ["gpt-4o"] } } },
      planner: { providers: { openai: {} } },
    });
  });

  it("re-reads and deletes only IDs still unavailable at confirmation time", async () => {
    mockModules.mockConfig.modelRouting.agentAccess.Explore.providers.openai.models
      .push("ancient");
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("cleanUnavailableRules").submenu("", vi.fn());
    ctx.modelRegistry.getAll.mockReturnValue([
      ...ctx.modelRegistry.getAll(),
      { provider: "openai", id: "retired" },
    ]);
    lastSelect().onSelect({ value: "Yes" });
    expect(mockModules.mockConfig.modelRouting.agentAccess).toEqual({
      Explore: { providers: { openai: { models: ["gpt-4o", "retired"] } } },
      "ghost-agent": { providers: { openai: { models: ["retired"] } } },
      planner: { providers: { openai: {} } },
    });
  });

  it("refreshes the catalogue when the action opens and closes after returning", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    ctx.modelRegistry.getAll.mockReturnValue([
      ...ctx.modelRegistry.getAll(),
      { provider: "openai", id: "retired" },
    ]);
    const done = vi.fn();
    const component = topItem("cleanUnavailableRules").submenu("", done);
    expect(done).not.toHaveBeenCalled();
    expect(component.render(100)).toContain("No unavailable model rules remain");
    await Promise.resolve();
    expect(done).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith("No unavailable model rules remain", "info");
    expect(mockModules.mockConfig.modelRouting.agentAccess.Explore.providers.openai.models)
      .toEqual(["gpt-4o", "retired"]);
  });

  it("never creates candidates from credential or getAvailable loss", async () => {
    mockModules.mockConfig.modelRouting.agentAccess = {
      Explore: { providers: { openai: { models: ["gpt-4o"] } } },
    };
    const ctx = createMockCtx();
    ctx.modelRegistry.getAvailable.mockReturnValue([
      { provider: "anthropic", id: "claude-sonnet-4-20250514" },
    ]);
    await showModelRoutingMenu(ctx);
    expect(topItem("cleanUnavailableRules")).toBeUndefined();
    expect(topItem("savedUnavailableProviders")).toBeDefined();
  });

  it("requires a reliable catalogue that still contains the provider", async () => {
    const missingProvider = createMockCtx();
    missingProvider.modelRegistry.getAll.mockReturnValue([
      { provider: "anthropic", id: "claude-sonnet-4-20250514" },
    ]);
    await showModelRoutingMenu(missingProvider);
    expect(topItem("cleanUnavailableRules")).toBeUndefined();

    settingsLists = [];
    selectLists = [];
    wrappers = [];
    const unreliable = createMockCtx();
    unreliable.modelRegistry.getError.mockReturnValue(new Error("catalogue failed"));
    await showModelRoutingMenu(unreliable);
    expect(topItem("cleanUnavailableRules")).toBeUndefined();
  });
});
