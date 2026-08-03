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
    constructor(component: any, options: any) { wrappers.push({ component, options }); }
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

describe("Model Routing top level", () => {
  beforeEach(reset);

  it("renders the OFF boundary without configuration rows", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    expect(wrappers[0].options.title).toBe("Model Routing");
    expect(topItem("enabled").currentValue).toBe("OFF");
    expect(topItem("quickSetup")).toBeUndefined();
    expect(topItem("enabledProviders")).toBeUndefined();
    expect(settingsLists[0].items.some((item) => item.label.includes("exact parent model"))).toBe(true);
  });

  it("toggles Model routing", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    settingsLists[0].onChange("enabled", "ON");
    expect(mockModules.mockConfig.modelRouting.enabled).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Model routing enabled", "info");
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
    expect(topItem("enabledProviders").currentValue).toBe("anthropic, openai");
    expect(topItem("agentAccess").currentValue).toBe("2 configured");
    expect(topItem("quickSetup")).toBeDefined();
    expect(topItem("clearAll")).toBeDefined();
  });

  it("clears the complete routing policy", async () => {
    mockModules.mockConfig.modelRouting = {
      enabled: true,
      enabledProviders: ["openai"],
      agentAccess: { Explore: { providers: { openai: {} } } },
    };
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("clearAll").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Yes" });
    expect(mockModules.mockConfig.modelRouting).toEqual({ enabled: false, enabledProviders: [], agentAccess: {} });
  });
});

describe("Provider picker", () => {
  beforeEach(() => {
    reset();
    mockModules.mockConfig.modelRouting.enabled = true;
  });

  it("hides unconfigured catalogue-only providers", async () => {
    const ctx = createMockCtx();
    ctx.modelRegistry.getAll.mockReturnValue([
      ...ctx.modelRegistry.getAll(),
      ...Array.from({ length: 40 }, (_, index) => ({ provider: `builtin-${index}`, id: "default" })),
    ]);
    await showModelRoutingMenu(ctx);
    topItem("enabledProviders").submenu("", vi.fn());
    const values = lastSelect().items.filter((item: any) => !item.nonSelectable).map((item: any) => item.value);
    expect(values).toEqual(["anthropic", "openai"]);

    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    const agentProviders = lastSelect().items
      .filter((item: any) => !item.nonSelectable)
      .map((item: any) => item.value);
    expect(agentProviders).toEqual(["anthropic", "openai"]);
  });

  it("reads current availability when the Provider submenu opens", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    ctx.modelRegistry.getAvailable.mockReturnValue([
      { provider: "anthropic", id: "claude-haiku-4" },
      { provider: "late-provider", id: "worker" },
    ]);
    topItem("enabledProviders").submenu("", vi.fn());
    const providers = lastSelect().items.filter((item: any) => !item.nonSelectable).map((item: any) => item.value);
    expect(providers).toEqual(["anthropic", "late-provider"]);
  });

  it("groups available built-in and third-party providers together", async () => {
    mockModules.mockConfig.modelRouting.enabledProviders = ["openai", "cpa-responses"];
    const ctx = createMockCtx();
    ctx.modelRegistry.getAvailable.mockReturnValue([
      ...ctx.modelRegistry.getAvailable(),
      { provider: "cpa-responses", id: "grok-4.5" },
    ]);
    await showModelRoutingMenu(ctx);
    topItem("enabledProviders").submenu("", vi.fn());
    const rows = lastSelect().items;
    expect(rows[0].label).toContain("Available providers");
    expect(rows.find((row: any) => row.value === "openai")).toBeDefined();
    expect(rows.find((row: any) => row.value === "cpa-responses")).toBeDefined();
    expect(rows.some((row: any) => row.label.includes("Saved but unavailable"))).toBe(false);
  });

  it("keeps prototype-like Provider IDs selectable and unconfigured", async () => {
    const ctx = createMockCtx();
    ctx.modelRegistry.getAvailable.mockReturnValue([
      ...ctx.modelRegistry.getAvailable(),
      { provider: "constructor", id: "worker" },
      { provider: "__proto__", id: "worker" },
    ]);
    await showModelRoutingMenu(ctx);
    topItem("enabledProviders").submenu("", vi.fn());
    const rows = lastSelect().items;
    expect(rows.find((row: any) => row.value === "constructor").nonSelectable).toBeUndefined();
    expect(rows.find((row: any) => row.value === "__proto__").nonSelectable).toBeUndefined();
    lastSelect().onSelect({ value: "__proto__" });
    expect(lastSettings().items.find((item: any) => item.id === "piAvailability").currentValue).toBe("Available");
  });

  it("places saved providers missing from Pi availability in a dormant group", async () => {
    mockModules.mockConfig.modelRouting.enabledProviders = ["google"];
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("enabledProviders").submenu("", vi.fn());
    const rows = lastSelect().items;
    const savedHeader = rows.findIndex((row: any) => row.label.includes("Saved but unavailable"));
    expect(savedHeader).toBeGreaterThan(rows.findIndex((row: any) => row.value === "openai"));
    expect(rows.findIndex((row: any) => row.value === "google")).toBeGreaterThan(savedHeader);
  });
});

describe("Quick model setup", () => {
  beforeEach(() => {
    reset();
    mockModules.mockConfig.modelRouting.enabled = true;
  });

  it("shows a locked Default row followed only by a separator", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("quickSetup").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    const rows = lastSelect().items;
    expect(rows[0].value).toBe("__default__");
    expect(rows[0].label).toContain("[✓] Default · anthropic/claude-sonnet-4-20250514");
    expect(rows[1].value).toBe("__separator__");
    expect(rows[1].label).toMatch(/^─+$/);
    expect(rows[2].value).toBe("__all__");
    expect(rows.some((row: any) => row.value === "claude-sonnet-4-20250514")).toBe(false);
  });

  it("writes current-provider exact access and enables canonical routing state", async () => {
    mockModules.mockConfig.modelRouting.enabled = false;
    const ctx = createMockCtx();
    // Construct while ON, then simulate a concurrent setting edit before Apply.
    mockModules.mockConfig.modelRouting.enabled = true;
    await showModelRoutingMenu(ctx);
    topItem("quickSetup").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    lastSelect().onSelect({ value: "claude-haiku-4" });
    lastSelect().onSelect({ value: "__apply__" });
    expect(lastSelect().items.map((item: any) => item.value)).toEqual(["Yes", "No"]);
    lastSelect().onSelect({ value: "Yes" });
    expect(mockModules.mockConfig.modelRouting).toEqual({
      enabled: true,
      enabledProviders: ["anthropic"],
      agentAccess: { Explore: { providers: { anthropic: { models: ["claude-haiku-4"] } } } },
    });
  });

  it("uses the canonical all-model rule", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("quickSetup").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    lastSelect().onSelect({ value: "__all__" });
    lastSelect().onSelect({ value: "__apply__" });
    lastSelect().onSelect({ value: "Yes" });
    expect(mockModules.mockConfig.modelRouting.agentAccess.Explore.providers.anthropic).toEqual({});
  });

  it("switches from All models to an exact rule when a model is selected", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("quickSetup").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    lastSelect().onSelect({ value: "__all__" });
    lastSelect().onSelect({ value: "claude-haiku-4" });
    lastSelect().onSelect({ value: "__apply__" });
    lastSelect().onSelect({ value: "Yes" });
    expect(mockModules.mockConfig.modelRouting.agentAccess.Explore.providers.anthropic)
      .toEqual({ models: ["claude-haiku-4"] });
  });

  it("refuses Quick setup without an active parent model", async () => {
    const ctx = createMockCtx();
    ctx.model = undefined;
    await showModelRoutingMenu(ctx);
    topItem("quickSetup").submenu("", vi.fn());
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Select a parent model before using Quick model setup",
      "warning",
    );
  });

  it("removes the provider rule when no alternates are selected", async () => {
    mockModules.mockConfig.modelRouting.agentAccess = {
      Explore: { providers: { anthropic: { models: ["claude-haiku-4"] } } },
    };
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("quickSetup").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    lastSelect().onSelect({ value: "claude-haiku-4" });
    lastSelect().onSelect({ value: "__apply__" });
    lastSelect().onSelect({ value: "Yes" });
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
    expect(lastSelect().items.find((item: any) => item.value === "Explore").description).toBe("openai/all");
    expect(lastSelect().items.find((item: any) => item.value === "reviewer").description).toBe("Parent only");
    expect(lastSelect().items.find((item: any) => item.value === "ghost-agent").label).toContain("agent unavailable");
  });

  it("shows Default, separator, and dormant provider summaries", async () => {
    mockModules.mockConfig.modelRouting.agentAccess = {
      Explore: { providers: { google: { models: ["gemini-2.5-pro"] } } },
    };
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    const rows = lastSelect().items;
    expect(rows[0].label).toContain("[✓] Default");
    expect(rows[1].value).toBe("__separator__");
    expect(rows.find((item: any) => item.value === "google").description).toContain("Saved but unavailable");
    expect(rows.find((item: any) => item.value === "google").description).toContain("Routing disabled");
  });

  it("marks the Default row unavailable when no parent model is active", async () => {
    const ctx = createMockCtx();
    ctx.model = undefined;
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    const defaultRow = lastSelect().items[0];
    expect(defaultRow.label).toContain("[ ] Default");
    expect(defaultRow.description).toContain("Unavailable");
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
    lastSelect().onSelect({ value: "openai" });
    expect(lastSelect().items.find((row: any) => row.value === "late-model")).toBeDefined();
  });

  it("does not inherit a saved rule for a prototype-like Provider ID", async () => {
    const ctx = createMockCtx();
    ctx.modelRegistry.getAvailable.mockReturnValue([
      ...ctx.modelRegistry.getAvailable(),
      { provider: "constructor", id: "worker" },
    ]);
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    expect(lastSelect().items.find((row: any) => row.value === "constructor").description).toBe("Available");
  });

  it("applies exact access without session or assignment layers", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    lastSelect().onSelect({ value: "openai" });
    lastSelect().onSelect({ value: "o3" });
    lastSelect().onSelect({ value: "__apply__" });
    expect(mockModules.mockConfig.modelRouting.agentAccess.Explore.providers.openai).toEqual({ models: ["o3"] });
  });

  it("distinguishes Active, Available, scope, and unavailable catalogue statuses", async () => {
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
    lastSelect().onSelect({ value: "Explore" });
    lastSelect().onSelect({ value: "openai" });
    const rows = lastSelect().items;
    expect(rows.find((row: any) => row.value === "o3").description).toBe("Active");
    expect(rows.find((row: any) => row.value === "gpt-4o").description).toBe("Out of current scope");
    expect(rows.find((row: any) => row.value === "gpt-4.1").description).toBe("Out of current scope");
    expect(rows.find((row: any) => row.value === "retired").description).toBe("Unavailable catalogue ID");
  });

  it("marks unselected selectable models as Available", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    lastSelect().onSelect({ value: "openai" });
    expect(lastSelect().items.find((row: any) => row.value === "o3").description).toBe("Available");
  });

  it("shows saved exact IDs as provider-unavailable without deleting them", async () => {
    mockModules.mockConfig.modelRouting.enabledProviders = ["google"];
    mockModules.mockConfig.modelRouting.agentAccess = {
      Explore: { providers: { google: { models: ["gemini-2.5-pro"] } } },
    };
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx);
    topItem("agentAccess").submenu("", vi.fn());
    lastSelect().onSelect({ value: "Explore" });
    lastSelect().onSelect({ value: "google" });
    expect(lastSelect().items.find((row: any) => row.value === "gemini-2.5-pro").description)
      .toBe("Provider unavailable");
    expect(mockModules.mockConfig.modelRouting.agentAccess.Explore.providers.google.models)
      .toEqual(["gemini-2.5-pro"]);
  });
});

describe("Provider lifecycle and cleanup", () => {
  beforeEach(() => {
    reset();
    mockModules.mockConfig.modelRouting = {
      enabled: true,
      enabledProviders: ["openai"],
      agentAccess: {
        Explore: { providers: { openai: { models: ["gpt-4o", "retired"] } } },
        "ghost-agent": { providers: { openai: { models: ["retired"] } } },
      },
    };
  });

  async function openOpenAI(ctx: any): Promise<void> {
    await showModelRoutingMenu(ctx);
    topItem("enabledProviders").submenu("", vi.fn());
    lastSelect().onSelect({ value: "openai" });
  }

  it("distinguishes routing, Pi availability, and effective access", async () => {
    const ctx = createMockCtx();
    await openOpenAI(ctx);
    expect(lastSettings().items.find((item: any) => item.id === "enabled").currentValue).toBe("ON");
    expect(lastSettings().items.find((item: any) => item.id === "piAvailability").currentValue).toBe("Available");
    expect(lastSettings().items.find((item: any) => item.id === "effectiveAccess").currentValue).toBe("Active");
  });

  it("pauses a provider without deleting saved rules", async () => {
    const ctx = createMockCtx();
    await openOpenAI(ctx);
    lastSettings().onChange("enabled", "OFF");
    expect(mockModules.mockConfig.modelRouting.enabledProviders).toEqual([]);
    expect(mockModules.mockConfig.modelRouting.agentAccess.Explore.providers.openai.models).toEqual(["gpt-4o", "retired"]);
  });

  it("renders real multiline unavailable cleanup and removes only missing IDs", async () => {
    const ctx = createMockCtx();
    await openOpenAI(ctx);
    const clean = lastSettings().items.find((item: any) => item.id === "cleanUnavailable");
    expect(clean).toBeDefined();
    const component = clean.submenu("", vi.fn());
    const rendered = component.render(100);
    expect(rendered).toContain("  Remove 2 unavailable openai model rules?");
    expect(rendered).toContain("  - Explore");
    expect(rendered).toContain("    - retired");
    expect(rendered).toContain("  - ghost-agent");
    lastSelect().onSelect({ value: "Yes" });
    expect(mockModules.mockConfig.modelRouting.agentAccess).toEqual({
      Explore: { providers: { openai: { models: ["gpt-4o"] } } },
    });
  });

  it("rechecks the registry before destructive unavailable cleanup", async () => {
    const ctx = createMockCtx();
    await openOpenAI(ctx);
    const clean = lastSettings().items.find((item: any) => item.id === "cleanUnavailable");
    clean.submenu("", vi.fn());
    ctx.modelRegistry.getAll.mockReturnValue([
      { provider: "anthropic", id: "claude-sonnet-4-20250514" },
      { provider: "openai", id: "gpt-4o" },
      { provider: "openai", id: "o3" },
      { provider: "openai", id: "retired" },
    ]);
    lastSelect().onSelect({ value: "Yes" });
    expect(mockModules.mockConfig.modelRouting.agentAccess).toEqual({
      Explore: { providers: { openai: { models: ["gpt-4o", "retired"] } } },
      "ghost-agent": { providers: { openai: { models: ["retired"] } } },
    });
  });

  it("keeps rules dormant and creates no cleanup candidate when availability is lost", async () => {
    mockModules.mockConfig.modelRouting.agentAccess = {
      Explore: { providers: { openai: { models: ["gpt-4o"] } } },
    };
    const ctx = createMockCtx();
    ctx.modelRegistry.getAvailable.mockReturnValue([
      { provider: "anthropic", id: "claude-sonnet-4-20250514" },
      { provider: "anthropic", id: "claude-haiku-4" },
    ]);
    await openOpenAI(ctx);
    expect(lastSettings().items.find((item: any) => item.id === "piAvailability").currentValue).toBe("Unavailable");
    expect(lastSettings().items.find((item: any) => item.id === "effectiveAccess").currentValue).toBe("Dormant");
    expect(lastSettings().items.find((item: any) => item.id === "cleanUnavailable")).toBeUndefined();
    expect(mockModules.mockConfig.modelRouting.agentAccess.Explore.providers.openai.models).toEqual(["gpt-4o"]);
  });

  it("does not offer unavailable cleanup while the provider is disabled", async () => {
    mockModules.mockConfig.modelRouting.enabledProviders = [];
    const ctx = createMockCtx();
    await openOpenAI(ctx);
    expect(lastSettings().items.find((item: any) => item.id === "cleanUnavailable")).toBeUndefined();
  });

  it("does not classify every saved ID as unavailable when the provider is absent", async () => {
    const ctx = createMockCtx();
    ctx.modelRegistry.getAll.mockReturnValue([{ provider: "anthropic", id: "claude-sonnet-4-20250514" }]);
    ctx.modelRegistry.getRegisteredProviderIds.mockReturnValue(["anthropic"]);
    await openOpenAI(ctx);
    expect(lastSettings().items.find((item: any) => item.id === "cleanUnavailable")).toBeUndefined();
  });

  it("deletes saved rules for registered and unavailable Agent types without changing Enabled", async () => {
    const ctx = createMockCtx();
    await openOpenAI(ctx);
    const remove = lastSettings().items.find((item: any) => item.id === "deleteRules");
    const component = remove.submenu("", vi.fn());
    expect(component.render(100)).toContain("  - ghost-agent");
    lastSelect().onSelect({ value: "Yes" });
    expect(mockModules.mockConfig.modelRouting.agentAccess).toEqual({});
    expect(mockModules.mockConfig.modelRouting.enabledProviders).toEqual(["openai"]);
  });
});
