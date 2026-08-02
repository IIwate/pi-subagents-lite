/**
 * menu-debug-new.test.ts — Tests for showDebugMenu using SelectList.
 *
 * After migration: uses ctx.ui.custom (not ctx.ui.select).
 * The debug menu is a SelectList with 2 items that execute actions on select.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { getAllTypes, getAvailableTypes, getAgentConfig } from "../../../src/agents/agent-types.js";

// Capture SelectList constructor calls
let selectListCalls: Array<{
  items: any[];
  maxVisible: number;
  onSelect?: (item: any) => void;
  onCancel?: () => void;
}> = [];

let settingsListWrapperCalls: Array<{
  component: any;
  options: any;
}> = [];

vi.mock("@earendil-works/pi-tui", () => {
  return {
    SettingsList: class MockSettingsList { constructor() {} },
    SelectList: class MockSelectList {
      items: any[];
      maxVisible: number;
      onSelect?: (item: any) => void;
      onCancel?: () => void;
      constructor(items: any[], maxVisible: number, _theme: any) {
        this.items = items;
        this.maxVisible = maxVisible;
        selectListCalls.push(this as any);
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
  };
});

// Capture SettingsListWrapper usage
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

// Import AFTER mock setup
import { showDebugMenu } from "../../../src/ui/menu/menu-debug.js";

describe("showDebugMenu — SelectList migration", () => {
  beforeEach(() => {
    selectListCalls = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
    (getAllTypes as any).mockReturnValue([]);
    (getAvailableTypes as any).mockReturnValue([]);
    (getAgentConfig as any).mockImplementation(() => undefined);
    mockModules.mockManager.debugDiagnostics.mockReset().mockReturnValue({ agents: [] });
  });

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("creates a SelectList with diagnostics, previews, and recovery tests", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    expect(selectListCalls.length).toBe(1);
    expect(selectListCalls[0].items).toHaveLength(15);
    expect(selectListCalls[0].items[0].value).toBe("agent-types");
    expect(selectListCalls[0].items[1].value).toBe("agent-briefing");
    expect(selectListCalls[0].items).toContainEqual(expect.objectContaining({
      value: "preview-needs-input",
      label: "Preview: Needs input",
    }));
    expect(selectListCalls[0].items).toContainEqual(expect.objectContaining({
      value: "arm-blocked-10s",
      label: "Arm: blocked · 10s",
    }));
    expect(selectListCalls[0].items.map(item => item.value)).not.toContain("arm-blocked-30m");
    expect(selectListCalls[0].items.map(item => item.value)).not.toContain("arm-provider-30m");
    expect(selectListCalls[0].items.map(item => item.value)).not.toContain("__sep__");
  });


  it("applies and clears UI-only status previews", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);

    await selectListCalls[0].onSelect!({ value: "preview-needs-input" });
    expect(mockModules.mockNavigator.setDebugStatusPreview).toHaveBeenCalledWith("needs_input");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Status preview set to Needs input", "info");

    await selectListCalls[0].onSelect!({ value: "preview-clear" });
    expect(mockModules.mockNavigator.setDebugStatusPreview).toHaveBeenCalledWith(undefined);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Status preview cleared", "info");
  });

  it("arms and clears a one-shot recovery test", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);

    await selectListCalls[0].onSelect!({ value: "arm-blocked-10s" });
    expect(mockModules.mockManager.armDebugFault).toHaveBeenCalledWith("output_blocked");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Armed output_blocked for the next agent", "info");

    await selectListCalls[0].onSelect!({ value: "arm-clear" });
    expect(mockModules.mockManager.clearDebugFault).toHaveBeenCalledOnce();
  });

  it("rebuilds recovery controls from manager state after arm and clear", async () => {
    mockModules.mockManager.debugDiagnostics
      .mockReset()
      .mockReturnValueOnce({ agents: [] })
      .mockReturnValueOnce({ armedFault: { kind: "output_blocked" }, agents: [] })
      .mockReturnValueOnce({ agents: [] });
    const ctx = createMockCtx();
    let round = 0;
    ctx.ui.custom = vi.fn(async (factory: any) => {
      let completion: unknown;
      factory(
        { terminal: { rows: 40, columns: 120 } },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
          italic: (text: string) => text,
        },
        null,
        (value: unknown) => { completion = value; },
      );
      const selectList = selectListCalls.at(-1)!;
      if (round === 0) {
        await selectList.onSelect!(selectList.items.find(item => item.value === "arm-blocked-10s"));
      } else if (round === 1) {
        await selectList.onSelect!(selectList.items.find(item => item.value === "arm-clear"));
      }
      round++;
      return completion;
    });

    await showDebugMenu(ctx);

    expect(selectListCalls).toHaveLength(3);
    expect(selectListCalls[0].items.find(item => item.value === "arm-blocked-10s")!.label)
      .toBe("Arm: blocked · 10s");
    expect(selectListCalls[1].items.find(item => item.value === "arm-blocked-10s")!.label)
      .toBe("Arm: blocked · 10s (armed)");
    expect(selectListCalls[2].items.find(item => item.value === "arm-blocked-10s")!.label)
      .toBe("Arm: blocked · 10s");
    expect(mockModules.mockManager.armDebugFault).toHaveBeenCalledWith("output_blocked");
    expect(mockModules.mockManager.clearDebugFault).toHaveBeenCalledOnce();
  });

  it("prints runtime diagnostics", async () => {
    mockModules.mockManager.debugDiagnostics.mockReturnValue({
      armedFault: { kind: "output_blocked" },
      agents: [{
        id: "agent-12345678",
        type: "Explore",
        status: "error",
        session: "live",
        settled: true,
        resultConsumed: false,
        recoverable: true,
        debugFaultKind: "output_blocked",
        recoveryPaused: true,
        recoveryRemainingMs: 8_000,
        error: "content was flagged",
      }],
    });
    const ctx = createMockCtx();
    await showDebugMenu(ctx);

    await selectListCalls[0].onSelect!({ value: "runtime-diagnostics" });
    const text = ctx.ui.notify.mock.calls.at(-1)?.[0];
    expect(text).toContain("Armed fault: output_blocked · next started Agent · 10s recovery");
    expect(text).toContain("Debug fault: output_blocked");
    expect(text).toContain("Recovery: Needs input · paused · 8s remaining");
  });

  it("wraps SelectList in SettingsListWrapper with title 'Debug'", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    expect(settingsListWrapperCalls.length).toBe(1);
    expect(settingsListWrapperCalls[0].options.title).toBe("Debug");
  });


});

describe("showDebugMenu — agent types action (SelectList)", () => {
  beforeEach(() => {
    selectListCalls = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
  });

  it("shows 'No agent types available' when getAllTypes returns empty", async () => {
    (getAllTypes as any).mockReturnValue([]);
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    // Simulate selecting "agent-types"
    selectListCalls[0].onSelect!({ value: "agent-types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });

  it("lists each agent type with its description", async () => {
    (getAllTypes as any).mockReturnValue(["general-purpose", "Explore"]);
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return { description: "General-purpose agent" };
      if (name === "Explore") return { description: "Explore agent" };
      return undefined;
    });
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types" });
    const notifyCall = ctx.ui.notify.mock.calls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("Available agent types"));
    expect(notifyCall).toBeDefined();
    expect(notifyCall[0]).toContain("general-purpose");
    expect(notifyCall[0]).toContain("General-purpose agent");
    expect(notifyCall[0]).toContain("Explore");
    expect(notifyCall[0]).toContain("Explore agent");
  });

  it("marks hidden types with [HIDDEN]", async () => {
    (getAllTypes as any).mockReturnValue(["secret-agent"]);
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "secret-agent") return { description: "Hidden agent", hidden: true };
      return undefined;
    });
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types" });
    const notifyCall = ctx.ui.notify.mock.calls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("secret-agent"));
    expect(notifyCall[0]).toContain("[HIDDEN]");
  });

  it("shows model when config has one", async () => {
    (getAllTypes as any).mockReturnValue(["test-agent"]);
    (getAgentConfig as any).mockImplementation(() => ({
      description: "Test agent",
      model: "claude-sonnet-4-20250514",
    }));
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types" });
    const notifyCall = ctx.ui.notify.mock.calls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("Available agent types"));
    expect(notifyCall[0]).toContain("Model: claude-sonnet-4-20250514");
  });

  it("shows registered tools when present", async () => {
    (getAllTypes as any).mockReturnValue(["tool-agent"]);
    (getAgentConfig as any).mockImplementation(() => ({
      description: "Agent with tools",
      registeredTools: ["file_read", "file_write"],
    }));
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types" });
    const notifyCall = ctx.ui.notify.mock.calls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("Available agent types"));
    expect(notifyCall[0]).toContain("Tools: file_read, file_write");
  });

  it("shows 'all built-in tools' when registeredTools is absent", async () => {
    (getAllTypes as any).mockReturnValue(["default-agent"]);
    (getAgentConfig as any).mockImplementation(() => ({
      description: "Default agent",
    }));
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types" });
    const notifyCall = ctx.ui.notify.mock.calls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("Available agent types"));
    expect(notifyCall[0]).toContain("Tools: all built-in tools");
  });

  it("skips types where getAgentConfig returns undefined", async () => {
    (getAllTypes as any).mockReturnValue(["known", "unknown"]);
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "known") return { description: "Known agent" };
      return undefined;
    });
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types" });
    const notifyCall = ctx.ui.notify.mock.calls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("Available agent types"));
    expect(notifyCall[0]).toContain("known");
    expect(notifyCall[0]).not.toContain("unknown");
  });

  it("shows source when present", async () => {
    (getAllTypes as any).mockReturnValue(["ext-agent"]);
    (getAgentConfig as any).mockImplementation(() => ({
      description: "Extension agent",
      source: ".pi/agents/ext-agent.md",
    }));
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types" });
    const notifyCall = ctx.ui.notify.mock.calls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("Available agent types"));
    expect(notifyCall[0]).toContain("Source: .pi/agents/ext-agent.md");
  });
});

describe("showDebugMenu — agent briefing action (SelectList)", () => {
  let mockSendUserMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    selectListCalls = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
    mockSendUserMessage = vi.fn();
    mockModules.mockPiInstance.sendUserMessage = mockSendUserMessage;
    (getAvailableTypes as any).mockReturnValue(["general-purpose", "Explore"]);
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return {
        displayName: "General Purpose",
        description: "General-purpose agent",
        registeredTools: ["file_read", "file_write"],
        model: "claude-sonnet-4-20250514",
        maxTurns: 50,
      };
      if (name === "Explore") return {
        description: "Explore agent",
      };
      return undefined;
    });
  });

  it("sends briefing to LLM via sendUserMessage", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("includes agent type headings in the briefing", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing" });
    const message = mockSendUserMessage.mock.calls[0][0];
    expect(message).toContain("General Purpose");
    expect(message).toContain("Explore");
  });

  it("includes tool and model info when present", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing" });
    const message = mockSendUserMessage.mock.calls[0][0];
    expect(message).toContain("**Tools:** file_read, file_write");
    expect(message).toContain("**Default model:** claude-sonnet-4-20250514");
    expect(message).toContain("**Max turns:** 50");
  });

  it("includes the parameters table with all required parameters", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing" });
    const message = mockSendUserMessage.mock.calls[0][0];
    expect(message).toContain("prompt");
    expect(message).toContain("description");
    expect(message).toContain("agent");
    expect(message).toContain("model");
    expect(message).toContain("thinking");
    expect(message).toContain("run_in_background");
    expect(message).toContain("worktree_path");
  });

  it("states the OFF routing boundary in the model routing briefing", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing" });
    const message = mockSendUserMessage.mock.calls[0][0];
    expect(message).toContain("When Cross-provider routing is OFF, do not pass `model`.");
    expect(message).toContain("the child will inherit the parent model");
    expect(message).toContain("When routing is ON, omit `model` by default");
    expect(message).toContain("Pass `model` only when the user explicitly requests a specific model");
    expect(message).toContain("Never silently replace a rejected model request");
  });

  it("notifies the user after sending the briefing", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });

  it("includes worktree_path usage guidelines", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing" });
    const message = mockSendUserMessage.mock.calls[0][0];
    expect(message).toContain("worktree_path");
    expect(message).toContain("git worktree of the parent");
    expect(message).toContain("Relative paths");
    expect(message).toContain(".pi/agents/");
  });

  it("includes usage guidelines for background agents", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing" });
    const message = mockSendUserMessage.mock.calls[0][0];
    expect(message).toContain("run_in_background");
    expect(message).toContain("do NOT poll");
    expect(message).toContain("sleep");
    expect(message).toContain("timeout");
    expect(message).toContain("advances automatically");
  });
});
