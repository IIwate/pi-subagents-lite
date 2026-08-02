/**
 * menu-model-routing.test.ts — Tests for showModelRoutingMenu.
 *
 * Covers the routing switch (OFF = strict parent inheritance), the allowed
 * provider allowlist (parent provider pinned), and agent model assignments
 * (session/permanent, "(inherits parent)" last, provider filtering).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules, selectDialogInstances, resetSelectDialogInstances } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { getAgentConfig, getAllTypes } from "../../../src/agents/agent-types.js";

let settingsListCalls: Array<any> = [];
let selectListInstances: Array<any> = [];
let settingsListWrapperCalls: Array<any> = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    items: any[];
    onChange: any;
    onCancel: any;
    constructor(items: any[], _max: number, _theme: any, onChange: any, onCancel: any) {
      this.items = items;
      this.onChange = onChange;
      this.onCancel = onCancel;
      settingsListCalls.push(this as any);
    }
    render() { return []; }
    handleInput() {}
    updateValue() {}
  },
  SelectList: class MockSelectList {
    items: any[];
    onSelect?: (item: any) => void;
    onCancel?: () => void;
    constructor(items: any[]) {
      this.items = items;
      selectListInstances.push(this as any);
    }
    render() { return []; }
    handleInput() {}
  },
  Input: class MockInput {
    value = "";
    onSubmit?: (v: string) => void;
    onEscape?: () => void;
    setValue(v: string) { this.value = v; }
    getValue() { return this.value; }
  },
}));

vi.mock("../../../src/ui/menu/wrappers/settings-list.js", () => ({
  SettingsListWrapper: class MockSettingsListWrapper {
    constructor(component: any, options: any) {
      settingsListWrapperCalls.push({ component, options });
    }
    render() { return []; }
    handleInput() {}
    invalidate() {}
  },
}));

import { showModelRoutingMenu } from "../../../src/ui/menu/menu-model-routing.js";

function resetAgentState(): void {
  mockModules.mockConfig.modelRouting = { enabled: false, allowedProviders: [], agentModels: {} };
  mockModules.mockConfig.agent = { forceBackground: false };
  mockModules.mockSessionOverrides = {};
}

/** The most recently created SelectList. */
function lastList(): any {
  return selectListInstances[selectListInstances.length - 1];
}

/** The most recently created SearchableSelectDialog (menu-mock-setup captures these). */
function lastDialog(): any {
  return selectDialogInstances[selectDialogInstances.length - 1];
}

/** The SettingsList item with the given id (undefined when absent). */
function item(id: string): any {
  return settingsListCalls[0].items.find((i: any) => i.id === id);
}

const MODEL_OPTIONS = [
  "anthropic/claude-sonnet-4-20250514",
  "openai/gpt-4o",
  "google/gemini-2.5-pro",
  "xai/grok-4",
];

describe("showModelRoutingMenu — routing switch", () => {
  beforeEach(() => {
    resetAgentState();
    settingsListCalls = [];
    selectListInstances = [];
    settingsListWrapperCalls = [];
    resetSelectDialogInstances();
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation(() => undefined);
    (getAllTypes as any).mockReturnValue(["Explore", "reviewer"]);
  });

  it("uses ctx.ui.custom (not ctx.ui.select/runMenuLoop)", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("defaults the routing switch to OFF", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    expect(item("enabled").currentValue).toBe("OFF");
  });

  it("toggles the switch and persists through the store", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    settingsListCalls[0].onChange("enabled", "ON");
    expect(mockModules.mockConfig.modelRouting.enabled).toBe(true);
  });

  it("OFF page shows only inheritance guidance — no provider/assignment config", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).not.toContain("allowedProviders");
    expect(ids).not.toContain("agentModels");
    expect(ids).not.toContain("clearAll");
    expect(settingsListCalls[0].items.some((i: any) => i.label.includes("Subagents use the exact parent model"))).toBe(true);
  });

  it("ON page shows provider and assignment summary rows", async () => {
    mockModules.mockConfig.modelRouting = {
      enabled: true,
      allowedProviders: ["openai", "google"],
      agentModels: { Explore: "openai/gpt-4o", reviewer: "google/gemini-2.5-pro" },
    };
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toContain("allowedProviders");
    expect(ids).toContain("agentModels");
    expect(ids).toContain("clearAll");
    expect(item("allowedProviders").currentValue).toBe("google, openai");
    expect(item("agentModels").currentValue).toBe("2 configured");
  });

  it("ON page shows '(parent only)' when the allowlist is empty", async () => {
    mockModules.mockConfig.modelRouting.enabled = true;
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    expect(item("allowedProviders").currentValue).toBe("(parent only)");
    expect(item("agentModels").currentValue).toBe("None");
  });

  it("Clear routing settings resets allowlist, assignments, switch, and session state", async () => {
    mockModules.mockConfig.modelRouting = {
      enabled: true,
      allowedProviders: ["openai"],
      agentModels: { Explore: "openai/gpt-4o" },
    };
    mockModules.mockSessionOverrides = { reviewer: "openai/gpt-5", "general-purpose": null };
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    const done = vi.fn();
    item("clearAll").submenu("", done);
    lastList().onSelect!({ value: "Yes" });
    expect(mockModules.mockConfig.modelRouting).toEqual({ enabled: false, allowedProviders: [], agentModels: {} });
    expect(mockModules.mockSessionOverrides).toEqual({});
    expect(ctx.ui.notify).toHaveBeenCalledWith("Routing settings cleared", "info");
    // Reopening the menu rebuilds from the cleared state (OFF page only).
    settingsListCalls = [];
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    expect(item("enabled").currentValue).toBe("OFF");
    expect(item("agentModels")).toBeUndefined();
  });
});

describe("showModelRoutingMenu — allowed providers", () => {
  beforeEach(() => {
    resetAgentState();
    mockModules.mockConfig.modelRouting.enabled = true;
    settingsListCalls = [];
    selectListInstances = [];
    settingsListWrapperCalls = [];
    resetSelectDialogInstances();
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation(() => undefined);
    (getAllTypes as any).mockReturnValue(["general-purpose", "Explore"]);
  });

  it("lists the parent provider as always available and not toggleable", async () => {
    const ctx = createMockCtx();
    ctx.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    item("allowedProviders").submenu("", vi.fn());

    const rows = selectListInstances[selectListInstances.length - 1].items;
    const parentRow = rows.find((r: any) => r.value === "anthropic");
    expect(parentRow.label).toBe("anthropic");
    expect(parentRow.description).toContain("Parent provider");
    expect(parentRow.description).toContain("always available");
  });

  it("marks allowed providers with [x] and disallowed with [ ]", async () => {
    mockModules.mockConfig.modelRouting.allowedProviders = ["openai"];
    const ctx = createMockCtx();
    ctx.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    item("allowedProviders").submenu("", vi.fn());

    const rows = selectListInstances[selectListInstances.length - 1].items;
    const openaiRow = rows.find((r: any) => r.value === "openai");
    const googleRow = rows.find((r: any) => r.value === "google");
    expect(openaiRow.label).toContain("[x]");
    expect(googleRow.label).toContain("[ ]");
  });

  it("toggling a provider on adds it to the allowlist", async () => {
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    const done = vi.fn();
    item("allowedProviders").submenu("", done);
    const list = lastList();
    list.onSelect!({ value: "openai", label: "openai  [ ]" });
    expect(mockModules.mockConfig.modelRouting.allowedProviders).toContain("openai");
    expect(ctx.ui.notify).toHaveBeenCalledWith("openai added to allowed providers", "info");
  });

  it("toggling a provider off without assignments removes it directly", async () => {
    mockModules.mockConfig.modelRouting.allowedProviders = ["openai"];
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    const done = vi.fn();
    item("allowedProviders").submenu("", done);
    const list = lastList();
    list.onSelect!({ value: "openai", label: "openai  [x]" });
    expect(mockModules.mockConfig.modelRouting.allowedProviders).not.toContain("openai");
    expect(ctx.ui.notify).toHaveBeenCalledWith("openai removed from allowed providers", "info");
  });

  it("removing a provider used by assignments asks for confirmation listing the agent types", async () => {
    mockModules.mockConfig.modelRouting = {
      enabled: true,
      allowedProviders: ["openai"],
      agentModels: { Explore: "openai/gpt-4o", researcher: "openai/gpt-5" },
    };
    mockModules.mockSessionOverrides = { planner: "openai/gpt-4o" };
    (getAllTypes as any).mockReturnValue(["Explore", "researcher", "planner"]);
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    const done = vi.fn();
    item("allowedProviders").submenu("", done);
    const list = lastList();
    list.onSelect!({ value: "openai", label: "openai  [x]" });

    // Confirmation list appears listing affected agent types.
    const confirmList = lastList();
    expect(confirmList.items.length).toBeGreaterThan(0);
    const yesItem = confirmList.items.find((i: any) => i.value === "Yes");
    expect(yesItem.description).toContain("Removing openai");
    expect(yesItem.description).toContain("Explore");
    expect(yesItem.description).toContain("researcher");
    expect(yesItem.description).toContain("planner");

    // Nothing changed until confirmed.
    expect(mockModules.mockConfig.modelRouting.allowedProviders).toContain("openai");
    expect(mockModules.mockConfig.modelRouting.agentModels.Explore).toBe("openai/gpt-4o");

    // Confirm: provider + persistent/session assignments cleared in one go.
    confirmList.onSelect!({ value: "Yes" });
    expect(mockModules.mockConfig.modelRouting.allowedProviders).not.toContain("openai");
    expect(mockModules.mockConfig.modelRouting.agentModels).toEqual({});
    expect(mockModules.mockSessionOverrides).toEqual({});
  });

  it("cancelling the removal confirmation leaves everything unchanged", async () => {
    mockModules.mockConfig.modelRouting = {
      enabled: true,
      allowedProviders: ["openai"],
      agentModels: { Explore: "openai/gpt-4o" },
    };
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    item("allowedProviders").submenu("", vi.fn());
    lastList().onSelect!({ value: "openai", label: "openai  [x]" });
    lastList().onSelect!({ value: "No" });
    expect(mockModules.mockConfig.modelRouting.allowedProviders).toEqual(["openai"]);
    expect(mockModules.mockConfig.modelRouting.agentModels).toEqual({ Explore: "openai/gpt-4o" });
  });

  it("lists unregistered agents with leftover assignments in the confirmation and clears them", async () => {
    mockModules.mockConfig.modelRouting = {
      enabled: true,
      allowedProviders: ["openai"],
      agentModels: { "ghost-agent": "openai/gpt-4o", Explore: "anthropic/claude-4" },
    };
    mockModules.mockSessionOverrides = { "dead-agent": "openai/gpt-5" };
    // Neither ghost-agent nor dead-agent is registered anymore.
    (getAllTypes as any).mockReturnValue(["Explore"]);
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    const done = vi.fn();
    item("allowedProviders").submenu("", done);
    lastList().onSelect!({ value: "openai", label: "openai  [x]" });

    const yesItem = lastList().items.find((i: any) => i.value === "Yes");
    expect(yesItem.description).toContain("Removing openai will clear assignments for:");
    expect(yesItem.description).toContain("- ghost-agent");
    expect(yesItem.description).toContain("- dead-agent");
    expect(yesItem.description).toContain("Continue?");

    lastList().onSelect!({ value: "Yes" });
    expect(mockModules.mockConfig.modelRouting.allowedProviders).not.toContain("openai");
    expect(mockModules.mockConfig.modelRouting.agentModels).toEqual({ Explore: "anthropic/claude-4" });
    expect(mockModules.mockSessionOverrides).toEqual({});
  });

  it("marks unregistered configured types as '(agent unavailable)' on the assignments page", async () => {
    mockModules.mockConfig.modelRouting = {
      enabled: true,
      allowedProviders: [],
      agentModels: { "ghost-agent": "openai/gpt-4o", Explore: "anthropic/claude-4" },
    };
    mockModules.mockSessionOverrides = { "dead-agent": null };
    (getAllTypes as any).mockReturnValue(["Explore"]);
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    item("agentModels").submenu("", vi.fn());
    const rows = lastList().items;
    const ghost = rows.find((r: any) => r.value === "ghost-agent");
    const dead = rows.find((r: any) => r.value === "dead-agent");
    expect(ghost.label).toBe("ghost-agent (agent unavailable)");
    expect(ghost.description).toBe("openai/gpt-4o");
    expect(dead.label).toBe("dead-agent (agent unavailable)");
    expect(dead.description).toBe("(inherits parent) [session]");
    expect(rows.find((r: any) => r.value === "Explore").label).toBe("Explore");
    // Unavailable types are not offered for new assignments.
    expect(rows.some((r: any) => r.value === "__assign__")).toBe(false);
  });

  it("marks saved providers missing from the current scope as unavailable and removable", async () => {
    mockModules.mockConfig.modelRouting.allowedProviders = ["xai", "openai"];
    const ctx = createMockCtx();
    // model options contain no xai models — xai becomes unavailable
    await showModelRoutingMenu(ctx, [
      "anthropic/claude-sonnet-4-20250514",
      "openai/gpt-4o",
    ]);
    item("allowedProviders").submenu("", vi.fn());
    const rows = lastList().items;
    const xaiRow = rows.find((r: any) => r.value === "xai");
    expect(xaiRow).toBeDefined();
    expect(xaiRow.label).toContain("[x]");
    expect(xaiRow.description).toContain("Not available");

    lastList().onSelect!({ value: "xai", label: "xai  [x]" });
    expect(mockModules.mockConfig.modelRouting.allowedProviders).toEqual(["openai"]);
  });
});

describe("showModelRoutingMenu — agent model assignments", () => {
  beforeEach(() => {
    resetAgentState();
    mockModules.mockConfig.modelRouting.enabled = true;
    settingsListCalls = [];
    selectListInstances = [];
    settingsListWrapperCalls = [];
    resetSelectDialogInstances();
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "Explore") return { name: "Explore", description: "", model: "openai/gpt-4o" };
      if (name === "general-purpose") return { name: "general-purpose", description: "" };
      return undefined;
    });
    (getAllTypes as any).mockReturnValue(["general-purpose", "Explore"]);
  });

  it("shows one row per agent type with its effective model", async () => {
    mockModules.mockConfig.modelRouting.agentModels = { Explore: "openai/gpt-4o" };
    const ctx = createMockCtx();
    ctx.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    item("agentModels").submenu("", vi.fn());

    const rows = lastList().items;
    const exploreRow = rows.find((r: any) => r.value === "Explore");
    const generalRow = rows.find((r: any) => r.value === "general-purpose");
    expect(exploreRow.description).toBe("openai/gpt-4o");
    expect(generalRow.description).toBe("(inherits parent)");
  });

  it("shows the [session] marker for session assignments", async () => {
    mockModules.mockSessionOverrides = { Explore: "google/gemini-2.5-pro" };
    const ctx = createMockCtx();
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    item("agentModels").submenu("", vi.fn());
    const exploreRow = lastList().items.find((r: any) => r.value === "Explore");
    expect(exploreRow.description).toBe("google/gemini-2.5-pro [session]");
  });

  it("filters the model selector to the parent provider and allowed providers, (inherits parent) last", async () => {
    mockModules.mockConfig.modelRouting.allowedProviders = ["openai"];
    const ctx = createMockCtx();
    ctx.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    const done = vi.fn();
    item("agentModels").submenu("", done);
    lastList().onSelect!({ value: "Explore", label: "Explore" });

    // Step 1 of the 2-step flow: model selection dialog.
    const dialog = lastDialog();
    expect(dialog.items.map((i: any) => i.value)).toEqual([
      "anthropic/claude-sonnet-4-20250514",
      "openai/gpt-4o",
      "(inherits parent)",
    ]);
  });

  it("sets a permanent assignment through the 2-step flow", async () => {
    const ctx = createMockCtx();
    ctx.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    const done = vi.fn();
    item("agentModels").submenu("", done);
    lastList().onSelect!({ value: "Explore", label: "Explore" });

    const dialog = lastDialog();
    dialog.callbacks.onSelect("openai/gpt-4o");
    const modeList = lastList();
    expect(modeList.items.map((i: any) => i.value)).toEqual(["session", "permanent"]);
    modeList.onSelect!({ value: "permanent" });
    expect(mockModules.mockConfig.modelRouting.agentModels.Explore).toBe("openai/gpt-4o");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Explore model set to openai/gpt-4o", "info");
  });

  it("sets a session assignment without persisting", async () => {
    const ctx = createMockCtx();
    ctx.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    item("agentModels").submenu("", vi.fn());
    lastList().onSelect!({ value: "Explore", label: "Explore" });
    lastDialog().callbacks.onSelect("openai/gpt-4o");
    lastList().onSelect!({ value: "session" });
    expect(mockModules.mockSessionOverrides.Explore).toBe("openai/gpt-4o");
    expect(mockModules.mockConfig.modelRouting.agentModels.Explore).toBeUndefined();
  });

  it("(inherits parent) clears a persistent assignment", async () => {
    mockModules.mockConfig.modelRouting.agentModels = { Explore: "openai/gpt-4o" };
    const ctx = createMockCtx();
    ctx.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    item("agentModels").submenu("", vi.fn());
    lastList().onSelect!({ value: "Explore", label: "Explore" });
    lastDialog().callbacks.onSelect("(inherits parent)");
    lastList().onSelect!({ value: "permanent" });
    expect(mockModules.mockConfig.modelRouting.agentModels.Explore).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Explore inherits parent model", "info");
  });

  it("(inherits parent) with Set for this session preserves a persistent assignment", async () => {
    mockModules.mockConfig.modelRouting.agentModels = { Explore: "openai/gpt-4o" };
    const ctx = createMockCtx();
    ctx.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    item("agentModels").submenu("", vi.fn());
    lastList().onSelect!({ value: "Explore", label: "Explore" });
    lastDialog().callbacks.onSelect("(inherits parent)");
    lastList().onSelect!({ value: "session" });
    // Session null = explicit parent inheritance for this session only.
    expect(mockModules.mockSessionOverrides.Explore).toBeNull();
    expect(mockModules.mockConfig.modelRouting.agentModels.Explore).toBe("openai/gpt-4o");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Explore inherits parent model", "info");
  });

  it("shows a session null assignment as '(inherits parent) [session]'", async () => {
    mockModules.mockSessionOverrides.Explore = null;
    mockModules.mockConfig.modelRouting.agentModels = { Explore: "openai/gpt-4o" };
    const ctx = createMockCtx();
    ctx.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    item("agentModels").submenu("", vi.fn());
    const row = lastList().items.find((i: any) => i.value === "Explore");
    expect(row.description).toBe("(inherits parent) [session]");
  });

  it("session assignment to a model leaves the persistent assignment untouched", async () => {
    mockModules.mockConfig.modelRouting.agentModels = { Explore: "openai/gpt-4o" };
    const ctx = createMockCtx();
    ctx.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    item("agentModels").submenu("", vi.fn());
    lastList().onSelect!({ value: "Explore", label: "Explore" });
    lastDialog().callbacks.onSelect("openai/gpt-4o");
    lastList().onSelect!({ value: "session" });
    expect(mockModules.mockSessionOverrides.Explore).toBe("openai/gpt-4o");
    expect(mockModules.mockConfig.modelRouting.agentModels.Explore).toBe("openai/gpt-4o");
  });

  it("permanent assignment clears the same-type session override", async () => {
    mockModules.mockSessionOverrides.Explore = "openai/gpt-5";
    const ctx = createMockCtx();
    ctx.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    item("agentModels").submenu("", vi.fn());
    lastList().onSelect!({ value: "Explore", label: "Explore" });
    lastDialog().callbacks.onSelect("openai/gpt-4o");
    lastList().onSelect!({ value: "permanent" });
    expect(mockModules.mockConfig.modelRouting.agentModels.Explore).toBe("openai/gpt-4o");
    expect(mockModules.mockSessionOverrides.Explore).toBeUndefined();
  });

  it("offers the Clear action only when a persistent assignment exists", async () => {
    mockModules.mockConfig.modelRouting.agentModels = { Explore: "openai/gpt-4o" };
    const ctx = createMockCtx();
    ctx.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    item("agentModels").submenu("", vi.fn());
    lastList().onSelect!({ value: "Explore", label: "Explore" });
    lastDialog().callbacks.onSelect("openai/gpt-4o");
    expect(lastList().items.map((i: any) => i.value)).toEqual(["session", "permanent", "clear"]);
    lastList().onSelect!({ value: "clear" });
    expect(mockModules.mockConfig.modelRouting.agentModels.Explore).toBeUndefined();
    expect(mockModules.mockSessionOverrides.Explore).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Explore assignment cleared", "info");
  });

  it("offers 'Assign another agent...' only for unassigned types and chains into the model flow", async () => {
    mockModules.mockConfig.modelRouting.agentModels = { Explore: "openai/gpt-4o" };
    const ctx = createMockCtx();
    ctx.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
    await showModelRoutingMenu(ctx, MODEL_OPTIONS);
    const done = vi.fn();
    item("agentModels").submenu("", done);

    const rows = lastList().items;
    expect(rows.some((r: any) => r.value === "__assign__")).toBe(true);
    lastList().onSelect!({ value: "__assign__", label: "Assign another agent..." });

    // Type picker lists only unassigned types.
    const typePicker = lastDialog();
    expect(typePicker.items.map((i: any) => i.value)).toEqual(["general-purpose"]);
    typePicker.callbacks.onSelect("general-purpose");

    // Model selector follows.
    const modelDialog = lastDialog();
    expect(modelDialog.items.map((i: any) => i.value)).toContain("(inherits parent)");
    modelDialog.callbacks.onSelect("google/gemini-2.5-pro");
    lastList().onSelect!({ value: "permanent" });
    expect(mockModules.mockConfig.modelRouting.agentModels["general-purpose"]).toBe("google/gemini-2.5-pro");
  });
});
