import { afterEach, describe, expect, it, vi } from "vitest";

// CustomEditor is only a fallback here; keep real pi-tui key/width behavior covered.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  CustomEditor: class {
    constructor(_tui: unknown, _theme: unknown, _keybindings?: unknown) {}
  },
}));

import type { AgentManager } from "../../src/agents/agent-manager.js";
import { AgentNavigator } from "../../src/ui/agent-navigator.js";

function makeRecord(id = "agent-12345678", status = "running"): any {
  return {
    id,
    display: {
      type: "Explore",
      description: "Inspect the project",
    },
    lifecycle: {
      status,
      startedAt: Date.now(),
    },
    execution: {
      session: {
        messages: [
          { role: "user", content: [{ type: "text", text: "Inspect the project" }] },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "I should inspect files." },
              { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
              { type: "text", text: "I found the project structure." },
            ],
          },
          {
            role: "toolResult",
            toolName: "read",
            isError: false,
            content: [{ type: "text", text: "# Project" }],
          },
        ],
        agent: { state: {} },
      },
    },
    stats: {
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      toolUses: 1,
      turnCount: 1,
      compactionCount: 0,
    },
  };
}

function makeManager(records: any[]): AgentManager {
  return {
    listAgents: () => records,
    getRecord: (id: string) => records.find(record => record.id === id),
  } as unknown as AgentManager;
}

function makeTheme(): any {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function makeComponent(text: string): any {
  return {
    render: () => [text],
    invalidate: vi.fn(),
  };
}

function makeContainer(text: string): any {
  return {
    children: [makeComponent(text)],
    render: () => [text],
    invalidate: vi.fn(),
  };
}

function makeNamedComponent(text: string, name: string): any {
  const component = makeComponent(text);
  Object.defineProperty(component, "constructor", { value: { name } });
  return component;
}

function makeChatContainer(text: string): any {
  return {
    children: [makeNamedComponent(text, "UserMessageComponent")],
    render: () => [text],
    invalidate: vi.fn(),
  };
}

function makeTui(prefixCount = 1): any {
  let clearOnShrink = false;
  const originalChat = makeChatContainer("parent chat");
  const originalPending = makeContainer("parent pending");
  const originalStatus = makeContainer("parent status");
  const chatIndex = prefixCount;
  const pendingIndex = chatIndex + 1;
  const statusIndex = chatIndex + 2;
  const editorIndex = chatIndex + 4;
  const belowIndex = chatIndex + 5;
  const footerIndex = chatIndex + 6;
  const originalFooter = {
    render: () => ["parent cwd", "parent stats"],
    invalidate: vi.fn(),
  };
  Object.defineProperty(originalFooter, "constructor", {
    value: { name: "FooterComponent" },
  });
  return {
    chatIndex,
    pendingIndex,
    statusIndex,
    editorIndex,
    belowIndex,
    footerIndex,
    originalChat,
    originalPending,
    originalStatus,
    originalFooter,
    children: [
      ...Array.from({ length: prefixCount }, (_, index) => makeContainer(`header ${index}`)),
      originalChat,
      originalPending,
      originalStatus,
      makeContainer("above widgets"),
      makeContainer("editor"),
      makeContainer("below widgets"),
      originalFooter,
    ],
    terminal: {
      columns: 120,
      rows: 40,
      write: vi.fn(),
    },
    getClearOnShrink: () => clearOnShrink,
    setClearOnShrink: vi.fn((enabled: boolean) => { clearOnShrink = enabled; }),
    requestRender: vi.fn(),
  };
}

function makeUI(editorText: { value: string }) {
  const widgets = new Map<string, any>();
  const theme = makeTheme();
  const baseEditor = {
    getText: () => editorText.value,
    setText: (text: string) => { editorText.value = text; },
    handleInput: vi.fn(),
    wantsKeyRelease: true,
    actionHandlers: new Map<string, () => void>(),
    addToHistory: vi.fn(),
    render: () => [],
    invalidate: vi.fn(),
  };
  let editorFactory: any = () => baseEditor;
  return {
    widgets,
    theme,
    baseEditor,
    get editorFactory() { return editorFactory; },
    ctx: {
      get theme() { return theme; },
      getEditorComponent: () => editorFactory,
      getEditorText: () => editorText.value,
      notify: vi.fn(),
      setEditorComponent: vi.fn((factory: any) => { editorFactory = factory; }),
      setEditorText: vi.fn((text: string) => { editorText.value = text; }),
      setWidget: vi.fn((key: string, content: any) => {
        if (content === undefined) widgets.delete(key);
        else widgets.set(key, content);
      }),
    },
  };
}

function mountSelector(ui: ReturnType<typeof makeUI>, tui = makeTui()): any {
  const selectorFactory = ui.widgets.get("agent-navigator-selector");
  expect(selectorFactory).toBeTypeOf("function");
  const selector = selectorFactory(tui, ui.theme);
  const editor = ui.editorFactory(tui, {}, {});
  const editorContainer = tui.children[tui.editorIndex];
  if (editorContainer?.children) editorContainer.children = [editor];
  const below = tui.children[tui.belowIndex];
  if (below?.children) below.children.push(selector);
  selector.render(120);
  return { tui, selector };
}

describe("AgentNavigator", () => {
  let navigator: AgentNavigator | undefined;

  afterEach(() => {
    navigator?.dispose();
    vi.useRealTimers();
  });

  it("registers a below-editor selector containing Main and subagents", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();

    const { selector } = mountSelector(ui);
    const text = selector.render(120).join("\n");

    // Claude-style rows use a filled active circle and no spinner column.
    expect(text).toContain("● Main");
    expect(text).toMatch(/○ \S+  Inspect the project/);
    expect(text).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(ui.ctx.setWidget).toHaveBeenCalledWith(
      "agent-navigator-selector",
      expect.any(Function),
      { placement: "belowEditor" },
    );
  });

  it("renders a fixed status column and marks continuable errors as needing input", () => {
    const running = makeRecord("agent-running", "running");
    const blocked = makeRecord("agent-blocked", "error");
    running.stats.toolUses = 1;
    blocked.stats.toolUses = 81;
    running.display.description = "Active task";
    blocked.display.description = "Blocked task";
    blocked.execution.settled = true;
    blocked.error = "content was flagged";
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([running, blocked]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    const lines = selector.render(120);
    const runningRow = lines.find((line: string) => line.includes("Active task"))!;
    const blockedRow = lines.find((line: string) => line.includes("Blocked task"))!;
    expect(runningRow).toContain("Running");
    expect(blockedRow).toContain("Needs input");
    expect(runningRow.indexOf("Running")).toBe(blockedRow.indexOf("Needs input"));
  });

  it.each([
    ["queued", "Queued"],
    ["running", "Running"],
    ["completed", "Done"],
    ["turn_limited", "Turn limit"],
    ["aborted", "Aborted"],
    ["stopped", "Stopped"],
    ["error", "Error"],
  ])("renders %s agents with the %s status", (status, label) => {
    const record = makeRecord(`agent-${status}`, status);
    if (status === "error") record.execution = { settled: true };
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    expect(selector.render(120).join("\n")).toContain(label);
  });

  it("keeps Needs input visible when a narrow terminal truncates other columns", () => {
    const record = makeRecord("agent-blocked", "error");
    record.execution.settled = true;
    record.error = "content was flagged";
    record.display.description = "A very long security audit description";
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);
    tui.terminal.columns = 42;

    const row = selector.render(42).find((line: string) => line.includes("Needs input"))!;
    expect(row).toContain("Needs input");
    expect(row).not.toContain("security audit description");
  });

  it("shows the recovery reason while a continuable failure is highlighted", () => {
    const record = makeRecord("agent-blocked", "error");
    record.execution.settled = true;
    record.error = "Provider finish_reason: content_filter";
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");

    expect(selector.render(120)[0]).toContain("Output blocked by provider");
    record.error = "provider internal error";
    expect(selector.render(120)[0]).toContain("Session failed after start");
  });

  it("shows non-continuable setup failures as errors", () => {
    const record = makeRecord("agent-error", "error");
    record.execution = { settled: true };
    record.error = "model unavailable";
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    const row = selector.render(120).find((line: string) => line.includes("Inspect the project"))!;
    expect(row).toContain("Error");
    expect(row).not.toContain("Needs input");
  });

  it("Ctrl+D then Enter clears inactive subagents and moves the highlight", () => {
    const r1 = makeRecord("agent-11111111");
    const r2 = makeRecord("agent-22222222");
    const records = [r1, r2];
    const ui = makeUI({ value: "" });
    const manager = makeManager(records) as any;
    manager.clear = vi.fn((id: string) => {
      const index = records.findIndex(record => record.id === id);
      if (index < 0) return false;
      records.splice(index, 1);
      return true;
    });
    navigator = new AgentNavigator(manager);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B"); // Empty editor + Down enters the list at Main.
    navigator.handleTerminalInput("\x1b[B"); // Highlight the first subagent.
    navigator.handleTerminalInput("\x04");   // Ctrl+D enters confirmation.
    expect(selector.render(120)[0]).toMatch(/^Delete\?/);

    navigator.handleTerminalInput("\r");     // Enter confirms.
    expect(manager.clear).toHaveBeenCalledWith("agent-11111111", "user");
    const lines = selector.render(120);
    expect(lines.join("\n")).not.toContain("Delete?");
    expect(lines[0]).toMatch(/^↑↓ move/);
  });

  it("uses native shrink clearing while the selector is mounted", () => {
    const records = [makeRecord("agent-11111111"), makeRecord("agent-22222222")];
    const ui = makeUI({ value: "" });
    const tui = makeTui();
    navigator = new AgentNavigator(makeManager(records));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui, tui);

    expect(tui.getClearOnShrink()).toBe(true);
    tui.requestRender.mockClear();

    records.splice(0, 1);
    navigator.update();

    // Pi now detects the exact whole-layout shrink during its normal render pass.
    expect(tui.requestRender).toHaveBeenCalledWith(false);
    expect(tui.requestRender).not.toHaveBeenCalledWith(true);

    records.length = 0;
    navigator.update();

    // The component stays registered but contributes zero rows. Keeping the component
    // identity stable prevents the next idle editor update from reusing stale row offsets.
    expect(ui.widgets.get("agent-navigator-selector")).toBeTypeOf("function");
    expect(tui.getClearOnShrink()).toBe(true);
    expect(tui.requestRender).toHaveBeenCalledWith(false);

    tui.requestRender.mockClear();
    navigator.forceLayoutReflow();
    expect(tui.requestRender).toHaveBeenCalledWith(true);

    navigator.dispose();
    navigator = undefined;
    expect(tui.getClearOnShrink()).toBe(false);
  });

  it("passes through Ctrl+C and cancels clear confirmation", () => {
    const record = makeRecord("agent-11111111");
    const secondRecord = makeRecord("agent-22222222");
    const ui = makeUI({ value: "" });
    const manager = makeManager([record, secondRecord]) as any;
    manager.clear = vi.fn(() => true);
    navigator = new AgentNavigator(manager);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x04");
    expect(selector.render(120).join("\n")).toContain("Delete?");

    // Ctrl+C is not consumed; pass it upward while cancelling confirmation.
    const result = navigator.handleTerminalInput("\x03");
    expect(result?.consume).toBeFalsy();
    expect(manager.clear).not.toHaveBeenCalled();
    expect(selector.render(120).join("\n")).not.toContain("Delete?");

    // Other keys are consumed only during confirmation; ordinary input returns to the editor after cancellation.
    expect(selector.render(120).join("\n")).toContain("↑↓ move");
  });

  it("respects the statsVisibility showCost toggle", () => {
    const record = makeRecord();
    record.stats.lifetimeUsage.cost = 0.05;
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    // Default without injected visibility: show cost.
    expect(selector.render(120).join("\n")).toContain("$");

    // Hiding showCost removes cost from the list.
    navigator.setStatsVisibility({ showCost: false });
    expect(selector.render(120).join("\n")).not.toContain("$");
  });

  it("right-aligns elapsed time and refreshes it once per second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const record = makeRecord();
    record.lifecycle.startedAt = Date.now() - 15_000;
    record.stats.toolUses = 0;
    record.stats.turnCount = 0;
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);

    const row0 = selector.render(120)[1];
    expect(row0).toMatch(/○ \S+  Inspect the project/);
    expect(row0).toHaveLength(120);
    expect(row0).toMatch(/15s$/);

    vi.advanceTimersByTime(1000);
    const row1 = selector.render(120)[1];
    expect(row1).toHaveLength(120);
    expect(row1).toMatch(/16s$/);
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it("stops refresh polling after an update failure and warns once", () => {
    vi.useFakeTimers();
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    const manager = makeManager([record]) as any;
    navigator = new AgentNavigator(manager);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    manager.listAgents = vi.fn(() => { throw new Error("navigator state unavailable"); });

    expect(() => vi.advanceTimersByTime(1500)).not.toThrow();

    expect(vi.getTimerCount()).toBe(0);
    expect(ui.ctx.notify).toHaveBeenCalledTimes(1);
    expect(ui.ctx.notify).toHaveBeenCalledWith(
      expect.stringContaining("navigator state unavailable"),
      "warning",
    );
  });

  it("contains repeated selector render failures and warns once", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    const manager = makeManager([record]) as any;
    navigator = new AgentNavigator(manager);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);
    manager.listAgents = vi.fn(() => { throw new Error("selector state unavailable"); });

    expect(selector.render(120)).toEqual([]);
    expect((navigator as any).refreshTimer).toBeUndefined();
    expect(selector.render(120)).toEqual([]);

    expect(ui.ctx.notify).toHaveBeenCalledTimes(1);
    expect(ui.ctx.notify).toHaveBeenCalledWith(
      expect.stringContaining("selector state unavailable"),
      "warning",
    );
  });

  it("requires Enter before changing the active agent", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");

    expect(navigator.selectedId()).toBeNull();
    expect(tui.children[tui.chatIndex]).toBe(tui.originalChat);

    navigator.handleTerminalInput("\r");

    expect(navigator.selectedId()).toBe(record.id);
    expect(tui.children[tui.chatIndex]).not.toBe(tui.originalChat);
    expect(tui.children[tui.pendingIndex]).not.toBe(tui.originalPending);
    expect(tui.children[tui.statusIndex]).not.toBe(tui.originalStatus);
    expect(tui.children[tui.footerIndex]).not.toBe(tui.originalFooter);
    expect(tui.terminal.write).toHaveBeenCalledWith("\x1b[3J");
  });

  it("keeps the selected agent focused after confirmation", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    const text = selector.render(120).join("\n");
    // Focus hint only renders while listFocused; retained after Enter so the
    // next Up still navigates without re-entering from the editor.
    expect(text).toContain("↑↓ move");
    expect(text).toContain("› ●");
    expect(text).toContain("Inspect the project");
    expect(navigator.handleTerminalInput("\x1b[A")).toEqual({ consume: true });
    expect(navigator.selectedId()).toBe(record.id);
    // Highlight moved to Main (○) while the selected agent remains active (●).
    expect(selector.render(120).join("\n")).toContain("› ○ Main");
  });

  it("Escape cancels a highlighted candidate without switching", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    const focused = selector.render(120).join("\n");
    expect(focused).toMatch(/› ○ \S+/);
    expect(focused).toContain("Inspect the project");
    expect(focused).toContain("↑↓ move"); // focus hint while list-focused

    navigator.handleTerminalInput("\x1b");

    expect(navigator.selectedId()).toBeNull();
    expect(tui.children[tui.chatIndex]).toBe(tui.originalChat);
  });

  it("restores the parent chat, pending, and status regions after confirmation", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    expect(navigator.selectedId()).toBe(record.id);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[A");
    expect(navigator.selectedId()).toBe(record.id);
    navigator.handleTerminalInput("\r");

    expect(navigator.selectedId()).toBeNull();
    expect(tui.children[tui.chatIndex]).toBe(tui.originalChat);
    expect(tui.children[tui.pendingIndex]).toBe(tui.originalPending);
    expect(tui.children[tui.statusIndex]).toBe(tui.originalStatus);
    expect(tui.children[tui.footerIndex]).toBe(tui.originalFooter);
  });

  it("decorates the editor and forwards printable input after leaving the list", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);

    const editor = ui.editorFactory(makeTui(), {}, {});
    expect(editor.wantsKeyRelease).toBe(true);
    editor.handleInput("\x1b[B");
    expect(ui.baseEditor.handleInput).not.toHaveBeenCalled();

    editor.handleInput("x");
    expect(ui.baseEditor.handleInput).toHaveBeenCalledWith("x");
  });

  it("routes ordinary editor submits before Pi can queue them on Main", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    const routeInput = vi.fn().mockResolvedValue(true);
    navigator = new AgentNavigator(makeManager([record]), routeInput);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    const editor = ui.editorFactory(makeTui(), {}, {});
    const parentSubmit = vi.fn();
    editor.onSubmit = parentSubmit;
    (ui.baseEditor as any).onSubmit("continue the child");

    expect(routeInput).toHaveBeenCalledWith(record.id, "continue the child");
    expect(ui.baseEditor.addToHistory).toHaveBeenCalledWith("continue the child");
    expect(parentSubmit).not.toHaveBeenCalled();

    const parentFollowUp = vi.fn();
    editor.actionHandlers.set("app.message.followUp", parentFollowUp);
    ui.baseEditor.setText("follow up the child");
    ui.baseEditor.actionHandlers.get("app.message.followUp")?.();
    expect(routeInput).toHaveBeenCalledWith(record.id, "follow up the child");
    expect(parentFollowUp).not.toHaveBeenCalled();
    expect(ui.baseEditor.getText()).toBe("");

    (ui.baseEditor as any).onSubmit("/agents");
    expect(parentSubmit).toHaveBeenCalledWith("/agents");
  });

  it("does not enter the selector when the editor contains text", () => {
    const record = makeRecord();
    const editorText = { value: "draft" };
    const ui = makeUI(editorText);
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);

    expect(navigator.handleTerminalInput("\x1b[B")).toBeUndefined();
    expect(navigator.selectedId()).toBeNull();
  });

  it("renders the selected subagent conversation as the root chat", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    const lines = tui.children[tui.chatIndex].render(120);
    const text = lines.join("\n");
    expect(text).toContain("Explore · agent-12 · running");
    expect(text).toContain("Inspect the project");
    expect(text).toContain("I should inspect files.");
    expect(text).toContain("read");
    expect(text).toContain("I found the project structure.");
    expect(text).toContain("# Project");
    expect(ui.widgets.has("agent-navigator-transcript")).toBe(false);
  });

  it("replaces Main footer stats with the selected subagent state", () => {
    const record = makeRecord();
    Object.assign(record.execution.session, {
      model: {
        id: "child-model",
        provider: "test",
        reasoning: true,
        contextWindow: 128_000,
      },
      thinkingLevel: "high",
      autoCompactionEnabled: true,
      modelRegistry: { isUsingOAuth: () => false },
      getSessionStats: () => ({
        tokens: {
          input: 12_000,
          output: 3_000,
          cacheRead: 20_000,
          cacheWrite: 0,
          total: 35_000,
        },
        cost: 0.25,
      }),
      getContextUsage: () => ({ percent: 25, contextWindow: 128_000 }),
      sessionManager: {
        getEntries: () => [],
      },
    });
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    const footerLines = tui.children[tui.footerIndex].render(120);
    expect(footerLines[0]).toBe("parent cwd");
    expect(footerLines[1]).toContain("↑12k");
    expect(footerLines[1]).toContain("25.0%/128k (auto)");
    expect(footerLines[1]).toContain("child-model • high");
    expect(footerLines[1]).not.toContain("parent stats");
  });

  it("hides a one-line Main custom footer while a subagent is selected", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const tui = makeTui();
    tui.originalFooter.render = () => ["main-model • xhigh"];
    mountSelector(ui, tui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    const footerLines = tui.children[tui.footerIndex].render(120);
    expect(footerLines).toHaveLength(1);
    expect(footerLines[0]).not.toContain("main-model");
  });

  it("adopts a footer replaced by another extension while Main is selected", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);
    const replacementFooter = {
      render: () => ["replacement cwd", "replacement stats"],
      invalidate: vi.fn(),
    };
    tui.children[tui.footerIndex] = replacementFooter;

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[A");
    navigator.handleTerminalInput("\r");

    expect(tui.children[tui.footerIndex]).toBe(replacementFooter);
  });

  it("reconciles a footer appended by another extension on the child screen", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    const replacementFooter = {
      render: () => ["replacement cwd", "replacement stats"],
      invalidate: vi.fn(),
    };
    const staleChildFooter = tui.children[tui.footerIndex];
    tui.children.push(replacementFooter);
    tui.originalFooter.render = () => { throw new Error("disposed footer rendered"); };

    expect(staleChildFooter.render(120)).toEqual([]);
    expect(tui.children).toHaveLength(tui.footerIndex + 1);
    expect(tui.children[tui.footerIndex]).not.toBe(replacementFooter);
    expect(tui.requestRender).toHaveBeenCalled();

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[A");
    navigator.handleTerminalInput("\r");
    expect(tui.children[tui.footerIndex]).toBe(replacementFooter);
  });

  it("keeps footer reconciliation active while a completed child is selected", () => {
    const record = makeRecord("agent-12345678", "completed");
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    expect((navigator as any).refreshTimer).toBeUndefined();
    mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    expect((navigator as any).refreshTimer).toBeDefined();
  });

  it("does not start a refresh timer before a TUI context is attached", () => {
    navigator = new AgentNavigator(makeManager([makeRecord()]));

    navigator.ensureTimer();

    expect((navigator as any).refreshTimer).toBeUndefined();
  });

  it("falls back to the main screen when the selected record disappears", () => {
    const records = [makeRecord()];
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager(records));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    expect(navigator.selectedId()).not.toBeNull();

    records.length = 0;
    navigator.update();

    expect(navigator.selectedId()).toBeNull();
    expect(tui.children[tui.chatIndex]).toBe(tui.originalChat);
    expect(ui.widgets.size).toBe(1);
    expect(selector.render(120)).toEqual([]);
  });

  it("restores root components without writing to the terminal during dispose", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    tui.terminal.write.mockClear();
    tui.requestRender.mockClear();

    navigator.dispose();
    navigator = undefined;

    expect(tui.children[tui.chatIndex]).toBe(tui.originalChat);
    expect(tui.children[tui.footerIndex]).toBe(tui.originalFooter);
    expect(tui.terminal.write).not.toHaveBeenCalled();
    expect(tui.requestRender).toHaveBeenCalledWith(true);
  });

  it("finishes disposal when a stale host widget rejects removal", () => {
    vi.useFakeTimers();
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);
    ui.ctx.setWidget.mockImplementation((_key: string, content: unknown) => {
      if (content === undefined) throw new Error("widget host disposed");
    });

    expect(() => navigator?.dispose()).not.toThrow();

    expect((navigator as any).refreshTimer).toBeUndefined();
    expect((navigator as any).uiCtx).toBeUndefined();
    expect(tui.getClearOnShrink()).toBe(false);
    expect(ui.ctx.notify).toHaveBeenCalledWith(
      expect.stringContaining("widget host disposed"),
      "warning",
    );
    navigator = undefined;
  });

  it("supports Pi layouts with a loaded-resources container before chat", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const tui = makeTui(2);
    tui.originalChat.children = [];
    const firstHeader = tui.children[0];
    const loadedResources = tui.children[1];
    mountSelector(ui, tui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    expect(navigator.selectedId()).toBe(record.id);
    expect(tui.children[tui.chatIndex]).not.toBe(tui.originalChat);
    expect(tui.children[0]).toBe(firstHeader);
    expect(tui.children[1]).toBe(loadedResources);
    expect(ui.ctx.notify).not.toHaveBeenCalledWith(
      "Subagent screen switching is unavailable: unsupported Pi TUI layout",
      "warning",
    );
  });

  it("rejects an unknown root region inserted between status and widgets", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const tui = makeTui(1);
    tui.originalChat.children = [
      makeNamedComponent("skill invocation", "SkillInvocationMessageComponent"),
    ];
    tui.children.splice(tui.statusIndex + 1, 0, makeContainer("unknown region"));
    tui.editorIndex += 1;
    tui.belowIndex += 1;
    mountSelector(ui, tui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    expect(navigator.selectedId()).toBeNull();
    expect(tui.children[tui.chatIndex]).toBe(tui.originalChat);
    expect(ui.ctx.notify).toHaveBeenCalledWith(
      "Subagent screen switching is unavailable: unsupported Pi TUI layout",
      "warning",
    );
  });

  it("rejects switching when the Pi root layout is unsupported", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const tui = makeTui();
    tui.children = [makeComponent("unknown")];
    mountSelector(ui, tui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    expect(navigator.selectedId()).toBeNull();
    expect(ui.ctx.notify).toHaveBeenCalledWith(
      "Subagent screen switching is unavailable: unsupported Pi TUI layout",
      "warning",
    );
  });
});
