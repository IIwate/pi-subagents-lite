import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CustomEditor is only a fallback here; keep real pi-tui key/width behavior covered.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  CustomEditor: class {
    constructor(_tui: unknown, _theme: unknown, _keybindings?: unknown) {}
  },
}));

import { ScrollView, VStack } from "@earendil-works/pi-tui";
import type { AgentManager } from "../../src/agents/agent-manager.js";
import { registerAgents } from "../../src/agents/agent-types.js";
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
        model: { id: "gpt-test", provider: "openai-test", reasoning: true },
        thinkingLevel: "high",
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
        subscribe: vi.fn(() => vi.fn()),
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
    togglePinned: vi.fn((id: string) => {
      const record = records.find(candidate => candidate.id === id);
      if (!record) return undefined;
      if (record.lifecycle.pinnedAt == null) {
        record.lifecycle.pinnedAt = Date.now();
        return true;
      }
      record.lifecycle.pinnedAt = undefined;
      return false;
    }),
  } as unknown as AgentManager;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function makeTheme(): any {
  return {
    fg: vi.fn((_color: string, text: string) => text),
    bold: vi.fn((text: string) => text),
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

function makeChatContainer(text: string): any {
  return {
    children: [makeComponent(text)],
    render: () => [text],
    invalidate: vi.fn(),
  };
}

function makeLiveContainer(children: any[]): any {
  return {
    children,
    render(width: number) {
      return this.children.flatMap((child: any) => child.render(width));
    },
    invalidate: vi.fn(),
  };
}

function makeTui(mode: "regular" | "fullscreen" = "regular"): any {
  let clearOnShrink = false;
  const originalChat = makeChatContainer("parent chat");
  const originalPending = makeContainer("parent pending");
  const originalStatus = makeContainer("parent status");
  const document = makeLiveContainer([
    makeContainer("header"),
    makeContainer("loaded resources"),
    originalChat,
  ]);
  const chatIndex = 2;
  const pendingIndex = 1;
  const statusIndex = 2;
  const editorIndex = 4;
  const belowIndex = 5;
  const footerIndex = 6;
  const originalFooter = {
    session: {
      getContextUsage: vi.fn(),
      sessionManager: { getCwd: vi.fn(), getEntries: vi.fn() },
    },
    footerData: { getGitBranch: vi.fn(), getExtensionStatuses: vi.fn() },
    setSession: vi.fn(),
    setAutoCompactEnabled: vi.fn(),
    render: () => ["parent cwd", "parent stats"],
    invalidate: vi.fn(),
  };
  const footerContainer = makeLiveContainer([originalFooter]);
  Object.defineProperty(originalFooter, "constructor", {
    value: { name: "FooterComponent" },
  });
  return {
    mode,
    document,
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
    footerContainer,
    children: [
      document,
      originalPending,
      originalStatus,
      makeContainer("above widgets"),
      makeContainer("editor"),
      makeContainer("below widgets"),
      footerContainer,
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

function makeSwitchableTui() {
  const regular = makeTui("regular");
  const rootComponents = [...regular.children];
  const transcript = new ScrollView(regular.document, {
    follow: "end",
    primary: true,
    overscroll: "chain",
  });
  const dock = new VStack([
    { component: regular.originalPending, shrink: 1, minSize: 0 },
    { component: regular.originalStatus, shrink: 1, minSize: 0 },
    { component: rootComponents[3], shrink: 1, minSize: 0 },
    { component: rootComponents[4], shrink: 1, minSize: 3 },
    { component: rootComponents[5], shrink: 1, minSize: 0 },
    { component: regular.footerContainer, shrink: 1, minSize: 1 },
  ]);
  const fullscreen = {
    ...regular,
    mode: "fullscreen",
    children: [] as any[],
    requestRender: vi.fn(),
  };
  let renderer = regular;
  const tui = new Proxy({}, {
    get: (_target, property) => {
      const value = Reflect.get(renderer, property, renderer);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => Reflect.apply(
        Reflect.get(renderer, property, renderer),
        renderer,
        args,
      );
    },
    set: (_target, property, value) => Reflect.set(renderer, property, value, renderer),
  }) as any;

  return {
    tui,
    regular,
    fullscreen,
    switchMode(mode: "regular" | "fullscreen") {
      if (renderer.mode === mode) return;
      const components = [...renderer.children];
      renderer.children = [];
      renderer = mode === "regular" ? regular : fullscreen;
      renderer.children = components;
    },
    renderCurrent(width = 120) {
      return renderer.mode === "fullscreen"
        ? [...transcript.render(width), ...dock.render(width)]
        : renderer.children.flatMap((child: any) => child.render(width));
    },
  };
}

function makeUI(editorText: { value: string }) {
  const widgets = new Map<string, any>();
  const statuses = new Map<string, string>();
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
    statuses,
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
      setStatus: vi.fn((key: string, text: string | undefined) => {
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      }),
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

  beforeEach(() => {
    registerAgents(new Map());
  });

  afterEach(() => {
    navigator?.dispose();
    registerAgents(new Map());
    vi.useRealTimers();
  });

  it("stays hidden before any subagent exists", () => {
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([]));
    navigator.setUICtx(ui.ctx as any);

    expect(ui.widgets.size).toBe(0);
    expect(ui.statuses.size).toBe(0);
  });

  it("defaults to an expanded list with controls on Main", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    const { selector } = mountSelector(ui);

    const rendered = selector.render(120).join("\n");
    expect(rendered).toContain(
      "● Main (1 running · 1 total · Alt+A collapse)",
    );
    expect(rendered).not.toContain(record.id);
    expect(ui.statuses.has("subagents-lite")).toBe(false);
  });

  it("shows nonzero pending results inline and hides zero", () => {
    let pending = 3;
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]), undefined, () => pending);
    navigator.setUICtx(ui.ctx as any);
    const { selector } = mountSelector(ui);

    expect(selector.render(120).join("\n")).toContain("3 results pending");

    pending = 0;
    navigator.update();
    expect(selector.render(120).join("\n")).not.toContain("pending result");
    expect(selector.render(120).join("\n")).not.toContain("results pending");
    expect(selector.render(120).join("\n")).not.toContain("waiting for next turn");
  });

  it("shows an error and an undelivered result independently", () => {
    const record = makeRecord("agent-needs-input", "error");
    record.execution.settled = true;
    record.error = "temporary provider failure";
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(
      makeManager([record]),
      undefined,
      () => 1,
    );
    navigator.setUICtx(ui.ctx as any);
    const { selector } = mountSelector(ui);

    const text = selector.render(120).join("\n");
    expect(text).toContain("Error");
    expect(text).not.toContain("needs input");
    expect(text).toContain("1 result pending");
  });

  it("lets the user collapse and expand the list", () => {
    const records = [makeRecord("agent-1"), makeRecord("agent-2", "queued")];
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager(records));
    navigator.setUICtx(ui.ctx as any);
    const { selector } = mountSelector(ui);

    navigator.toggleList();
    expect(selector.render(120)).toEqual([]);
    expect(ui.statuses.get("subagents-lite")).toBe(
      "Subagents (1 running · 1 queued · 2 total · Alt+A expand)",
    );
    expect(navigator.handleTerminalInput("\x1b[B")).toBeUndefined();

    navigator.toggleList();
    expect(selector.render(120).join("\n")).toContain(
      "● Main (1 running · 1 queued · 2 total · Alt+A collapse)",
    );
    expect(ui.statuses.has("subagents-lite")).toBe(false);
  });

  it("starts folded when the default expansion setting is off", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]), undefined, undefined, undefined, false);
    navigator.setUICtx(ui.ctx as any);
    const { selector } = mountSelector(ui);

    expect(selector.render(120)).toEqual([]);
    expect(ui.statuses.get("subagents-lite")).toBe(
      "Subagent (1 running · 1 total · Alt+A expand)",
    );

    navigator.toggleList();
    expect(selector.render(120).join("\n")).toContain(
      "● Main (1 running · 1 total · Alt+A collapse)",
    );
  });

  it("returns to Main without changing expanded or collapsed list state", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    expect(navigator.selectedId()).toBe(record.id);
    const activeMain = selector.render(120).find((line: string) => line.includes("Main"))!;
    expect(activeMain.indexOf("Alt+A collapse")).toBeLessThan(activeMain.indexOf("Alt+M main"));
    expect(ui.statuses.has("subagents-lite")).toBe(false);

    navigator.activateMain();
    expect(navigator.selectedId()).toBeNull();
    expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);
    const mainText = selector.render(120).join("\n");
    expect(mainText).toContain("● Main");
    expect(mainText).not.toContain("Alt+M main");
    expect(ui.statuses.has("subagents-lite")).toBe(false);

    tui.requestRender.mockClear();
    ui.ctx.setStatus.mockClear();
    navigator.activateMain();
    expect(tui.requestRender).not.toHaveBeenCalled();
    expect(ui.ctx.setStatus).not.toHaveBeenCalled();

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    navigator.toggleList();
    expect(selector.render(120)).toEqual([]);
    expect(ui.statuses.get("subagents-lite")).toContain("Alt+M main");

    navigator.activateMain();
    expect(navigator.selectedId()).toBeNull();
    expect(selector.render(120)).toEqual([]);
    expect(ui.statuses.get("subagents-lite")).toBe(
      "Subagent (1 running · 1 total · Alt+A expand)",
    );
  });

  it("preserves the user's collapsed choice while the record list is empty", () => {
    const records = [makeRecord()];
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager(records));
    navigator.setUICtx(ui.ctx as any);
    const { selector } = mountSelector(ui);
    navigator.toggleList();

    records.length = 0;
    navigator.update();
    expect(ui.statuses.has("subagents-lite")).toBe(false);
    expect(selector.render(120)).toEqual([]);

    records.push(makeRecord("agent-next"));
    navigator.update();
    expect(selector.render(120)).toEqual([]);
    expect(ui.statuses.get("subagents-lite")).toBe(
      "Subagent (1 running · 1 total · Alt+A expand)",
    );
  });

  it("shows errors without a separate input-waiting count", () => {
    const record = makeRecord();
    record.lifecycle.status = "error";
    record.execution.settled = true;
    record.error = "503 service unavailable";
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    const { selector } = mountSelector(ui);
    const expanded = stripAnsi(selector.render(120).join("\n"));
    expect(expanded).toContain("Error");
    expect(expanded).not.toContain("needs input");
    navigator.toggleList();

    const status = stripAnsi(ui.statuses.get("subagents-lite")!);
    expect(status).toBe("Subagent (1 total · Alt+A expand)");
    expect(selector.render(120)).toEqual([]);
  });

  it("clears the folded footer status when disposed", () => {
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([makeRecord()]));
    navigator.setUICtx(ui.ctx as any);
    navigator.toggleList();
    expect(ui.statuses.has("subagents-lite")).toBe(true);

    navigator.dispose();
    navigator = undefined;
    expect(ui.statuses.has("subagents-lite")).toBe(false);
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
    expect(text).toMatch(/○ \S+ \(Running\)  Inspect the project/);
    expect(text).toContain("openai-test/gpt-test(high)");
    expect(text).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(ui.ctx.setWidget).toHaveBeenCalledWith(
      "agent-navigator-selector",
      expect.any(Function),
      { placement: "belowEditor" },
    );
  });

  it("keeps Main sticky with complete counts and six visible subagents", () => {
    const records = Array.from({ length: 8 }, (_, index) => {
      const status = index < 2 ? "running" : index === 2 ? "queued" : "completed";
      const record = makeRecord(`agent-${index}`, status);
      record.display.description = `Task ${index}`;
      return record;
    });
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager(records));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    let lines = selector.render(120);
    expect(lines[0]).toContain("● Main (2 running · 1 queued · 8 total · Alt+A collapse)");
    expect(lines.filter((line: string) => line.includes("Task "))).toHaveLength(6);

    navigator.handleTerminalInput("\x1b[B");
    for (let index = 0; index < 8; index++) navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    lines = selector.render(120);
    expect(lines.find((line: string) => line.includes("Main"))).toContain(
      "○ Main (2 running · 1 queued · 8 total · Alt+A collapse · Alt+M main)",
    );
    expect(lines.filter((line: string) => line.includes("Task "))).toHaveLength(6);
  });

  it("hides zero running and queued counts when only terminal records remain", () => {
    const records = [makeRecord("done-1", "completed"), makeRecord("done-2", "completed")];
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager(records));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    const summary = selector.render(120)[0];
    expect(summary).toContain("2 total");
    expect(summary).not.toContain("0 running");
    expect(summary).not.toContain("0 queued");
  });

  it("keeps error status adjacent to its stats", () => {
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
    const blockedRow = stripAnsi(lines.find((line: string) => line.includes("Blocked task"))!);
    expect(runningRow).toMatch(/Explore \(Running\) {2}Active task/);
    expect(blockedRow).toMatch(/Explore \(Error\) {2}Blocked task/);
    expect(runningRow).toMatch(/openai-test\/gpt-test\(high\)/);
  });

  it("preserves manager order without moving Main", () => {
    const done = makeRecord("agent-done", "completed");
    const running = makeRecord("agent-running", "running");
    const blocked = makeRecord("agent-blocked", "error");
    done.display.description = "Done task";
    running.display.description = "Running task";
    blocked.display.description = "Blocked task";
    blocked.execution.settled = true;
    blocked.error = "content was flagged";
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([done, running, blocked]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    const lines = selector.render(120);
    expect(lines[0]).toContain("Main");
    expect(lines.findIndex((line: string) => line.includes("Done task")))
      .toBeLessThan(lines.findIndex((line: string) => line.includes("Running task")));
    expect(lines.findIndex((line: string) => line.includes("Running task")))
      .toBeLessThan(lines.findIndex((line: string) => line.includes("Blocked task")));
  });

  it("renders a debug status preview without mutating agent lifecycle", () => {
    const record = makeRecord("agent-running", "running");
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    navigator.setDebugStatusPreview("error");
    expect(selector.render(120).join("\n")).toContain("Error");
    expect(record.lifecycle.status).toBe("running");

    navigator.setDebugStatusPreview(undefined);
    expect(selector.render(120).join("\n")).toContain("Running");
  });

  it("marks records created by Debug fault injection", () => {
    const record = makeRecord("agent-debug", "error");
    record.execution.settled = true;
    record.execution.debugFaultKind = "output_blocked";
    record.error = "debug injected: content was flagged";
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);

    const listText = stripAnsi(selector.render(120).join("\n"));
    expect(listText).toContain("Explore [DEBUG] (Error)");
    expect(listText).not.toContain("Error (Debug)");

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    const transcript = stripAnsi(tui.document.children[tui.chatIndex].render(120).join("\n"));
    expect(transcript).toContain("Explore [DEBUG] (Error)");
    expect(transcript).not.toContain("agent-de");
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

  it("keeps Error visible when a narrow terminal truncates other columns", () => {
    const record = makeRecord("agent-blocked", "error");
    record.execution.settled = true;
    record.execution.debugFaultKind = "output_blocked";
    record.error = "content was flagged";
    record.display.description = "A very long security audit description";
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);
    tui.terminal.columns = 42;

    const row = selector.render(42).find((line: string) => line.includes("Error"))!;
    expect(row).toContain("Error");
    expect(row).not.toContain("security audit description");
  });

  it("preserves status and provider-first identity space for a long custom display name", () => {
    registerAgents(new Map([[
      "long-agent",
      {
        name: "long-agent",
        displayName: "Extremely Long Custom Agent Display Name",
        description: "Long name test",
        systemPrompt: "Review the project.",
      } as any,
    ]]));
    const record = makeRecord("agent-long", "running");
    record.display.type = "long-agent";
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);
    tui.terminal.columns = 42;

    const rows = selector.render(42);
    expect(rows.join("\n")).toContain("(Running)");
    expect(rows.join("\n")).toContain("openai-test");
    expect(rows.join("\n")).toContain("gpt-tes");
  });

  it("omits provider and model stats when subagent matches the parent session model completely", () => {
    const record = makeRecord("agent-matched", "running");
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(
      makeManager([record]),
      undefined,
      undefined,
      () => ({ providerName: "openai-test", modelName: "gpt-test", thinkingLevel: "high" }),
    );
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    const rendered = selector.render(120).join("\n");
    expect(rendered).not.toContain("openai-test");
    expect(rendered).not.toContain("gpt-test");
    expect(rendered).not.toContain("high");
    expect(rendered).toContain("1 call");
  });

  it("shows only model and thinking when only model or thinking level differs from parent", () => {
    const diffModel = makeRecord("agent-diff-model", "running");
    diffModel.execution.session!.model = { id: "gpt-other", provider: "openai-test" } as any;
    const diffThinking = makeRecord("agent-diff-thinking", "running");
    diffThinking.execution.session!.thinkingLevel = "low";

    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(
      makeManager([diffModel, diffThinking]),
      undefined,
      undefined,
      () => ({ providerName: "openai-test", modelName: "gpt-test", thinkingLevel: "high" }),
    );
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    const rendered = selector.render(120).join("\n");
    expect(rendered).toContain("gpt-other(high)");
    expect(rendered).toContain("gpt-test(low)");
    expect(rendered).not.toContain("openai-test");
  });

  it("shows full provider/model(thinking) when provider differs from parent", () => {
    const diffProvider = makeRecord("agent-diff-provider", "running");
    diffProvider.execution.session!.model = { id: "claude-sonnet", provider: "anthropic-test" } as any;

    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(
      makeManager([diffProvider]),
      undefined,
      undefined,
      () => ({ providerName: "openai-test", modelName: "gpt-test", thinkingLevel: "high" }),
    );
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    const rendered = selector.render(120).join("\n");
    expect(rendered).toContain("anthropic-test/claude-sonnet(high)");
  });

  it("drops tokens and cost first when width is constrained, preserving tools, duration, and identity", () => {
    const record = makeRecord("agent-long-stats", "running");
    record.display.description = "A".repeat(40);
    record.stats.toolUses = 15;
    record.stats.turnCount = 10;
    record.stats.lifetimeUsage.input = 15000;
    record.stats.lifetimeUsage.output = 3000;
    record.stats.lifetimeUsage.cost = 0.45;
    record.execution.session!.model = { id: "custom-model", provider: "custom-provider" } as any;

    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);

    // Columns = 95: enough for tools/duration/identity/context, but tight with tokens+cost
    tui.terminal.columns = 95;
    const line = selector.render(95).find((l: string) => l.includes("custom-model"))!;

    // Level 1 dropped tokens (↑/↓) and cost ($)
    expect(line).not.toContain("↑");
    expect(line).not.toContain("↓");
    expect(line).not.toContain("$");
    // Preserved tools, duration, and identity
    expect(line).toContain("custom-provider/custom-model");
    expect(line).toContain("15 calls");
    expect(line).toContain("<1s");
  });

  it("drops context and turns in level 2 degradation under extreme width pressure", () => {
    const record = makeRecord("agent-tight", "running");
    record.display.description = "B".repeat(40);
    record.stats.toolUses = 5;
    record.stats.turnCount = 8;
    record.stats.lifetimeUsage.input = 10000;
    record.stats.lifetimeUsage.output = 2000;
    record.stats.lifetimeUsage.cost = 0.25;
    record.stats.contextPercent = 65;
    record.execution.session!.model = { id: "m", provider: "p" } as any;

    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);

    // Columns = 75: extreme pressure where context % and turns must drop to keep 40 chars
    tui.terminal.columns = 75;
    const line = selector.render(75).find((l: string) => l.includes("p/m"))!;

    expect(line).not.toContain("↑");
    expect(line).not.toContain("$");
    expect(line).not.toContain("65%");
    expect(line).not.toContain("8⟳");
    // Bottom line preserved: identity, tools, and duration
    expect(line).toContain("p/m");
    expect(line).toContain("5 calls");
    expect(line).toContain("<1s");
  });

  it("shows ordinary navigation controls for highlighted errors", () => {
    const record = makeRecord("agent-error", "error");
    record.execution.settled = true;
    record.error = "Provider finish_reason: content_filter";
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");

    const command = stripAnsi(selector.render(120)[0]);
    expect(command).toContain("Enter Open");
    expect(command).not.toContain("provider");
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
  });

  it("toggles highlighted pins with Space without changing status order", () => {
    const done = makeRecord("agent-done", "completed");
    const running = makeRecord("agent-running", "running");
    const error = makeRecord("agent-error", "error");
    error.execution.settled = true;
    error.error = "provider internal error";
    const records = [done, running, error];
    const ui = makeUI({ value: "" });
    const manager = makeManager(records) as any;
    navigator = new AgentNavigator(manager);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B"); // Focus Main.
    navigator.handleTerminalInput(" ");
    expect(ui.ctx.notify).toHaveBeenCalledWith("Cannot pin Main agent", "warning");

    navigator.handleTerminalInput("\x1b[B"); // Done.
    navigator.handleTerminalInput(" ");

    let lines = selector.render(120);
    const doneIndex = lines.findIndex((line: string) => line.includes("Done"));
    const runningIndex = lines.findIndex((line: string) => line.includes("Running"));
    const errorIndex = lines.findIndex((line: string) => line.includes("Error"));
    expect(manager.togglePinned).toHaveBeenCalledWith(done.id);
    expect(lines[doneIndex]).toContain("○ Explore");
    expect(lines[doneIndex]).toContain("◆");
    expect(lines.join("\n")).toContain("Space Unpin");
    expect(doneIndex).toBeLessThan(runningIndex);
    expect(runningIndex).toBeLessThan(errorIndex);

    navigator.handleTerminalInput("\r");
    lines = selector.render(120);
    expect(lines.find((line: string) => line.includes("Done"))).toContain("● Explore");
    expect(lines.find((line: string) => line.includes("Done"))).toContain("◆");
    expect(lines.find((line: string) => line.includes("Main"))).toContain("○ Main");

    navigator.handleTerminalInput(" ");
    lines = selector.render(120);
    expect(lines.find((line: string) => line.includes("Done"))).toContain("● Explore");
    expect(lines.find((line: string) => line.includes("Done"))).not.toContain("◆");
    expect(lines.join("\n")).toContain("Space Pin");
  });

  it("renders an inactive pinned indicator with the accent color", () => {
    const record = makeRecord("agent-pinned", "completed");
    record.lifecycle.pinnedAt = Date.now();
    const ui = makeUI({ value: "" });
    const fg = vi.spyOn(ui.theme, "fg");
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    selector.render(120);

    expect(fg).toHaveBeenCalledWith("accent", "◆");
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
    expect(selector.render(120)[0]).toBe(' Remove “Inspect the project”? · Enter Remove · Esc Cancel');

    navigator.handleTerminalInput("\r");     // Enter confirms.
    expect(manager.clear).toHaveBeenCalledWith("agent-11111111", "user");
    const lines = selector.render(120);
    expect(lines.join("\n")).not.toContain("Remove “Inspect the project”?");
    expect(lines[0]).toMatch(/^ ↑↓ Move/);
  });

  it("requests a redraw when the displayed model changes", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    const tui = makeTui();
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui, tui);
    tui.requestRender.mockClear();

    record.execution.session.model.id = "gpt-updated";
    navigator.update();

    expect(tui.requestRender).toHaveBeenCalledWith(false);
  });

  it("requests a redraw when displayed usage changes", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    const tui = makeTui();
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui, tui);
    tui.requestRender.mockClear();

    record.stats.compactionCount = 1;
    record.stats.lifetimeUsage.cost = 0.25;
    navigator.update();

    expect(tui.requestRender).toHaveBeenCalledWith(false);
  });

  it("uses native shrink clearing while the selector is mounted", () => {
    const records = [makeRecord("agent-11111111"), makeRecord("agent-22222222")];
    const ui = makeUI({ value: "" });
    const tui = makeTui();
    navigator = new AgentNavigator(makeManager(records));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui, tui);

    expect(tui.getClearOnShrink()).toBe(true);
    tui.requestRender.mockClear();

    records.splice(0, 1);
    navigator.update();

    // Pi now detects the exact whole-layout shrink during its normal render pass.
    expect(tui.requestRender).toHaveBeenCalledWith(false);
    expect(tui.requestRender).not.toHaveBeenCalledWith(true);

    records.length = 0;
    navigator.update();

    // Keep the component identity stable while contributing no visible rows.
    expect(ui.widgets.get("agent-navigator-selector")).toBeTypeOf("function");
    expect(tui.getClearOnShrink()).toBe(true);
    expect(tui.requestRender).toHaveBeenCalledWith(false);
    expect(selector.render(120)).toEqual([]);

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
    expect(selector.render(120).join("\n")).toContain("Remove “Inspect the project”? · Enter Remove · Esc Cancel");

    // Ctrl+C is not consumed; pass it upward while cancelling confirmation.
    const result = navigator.handleTerminalInput("\x03");
    expect(result?.consume).toBeFalsy();
    expect(manager.clear).not.toHaveBeenCalled();
    expect(selector.render(120).join("\n")).not.toContain("Remove “Inspect the project”?");

    // Other keys are consumed only during confirmation; ordinary input returns to the editor after cancellation.
    expect(selector.render(120).join("\n")).toContain("↑↓ Move");
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
    expect(row0).toMatch(/○ \S+ \(Running\)  Inspect the project/);
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
    expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);

    navigator.handleTerminalInput("\r");

    expect(navigator.selectedId()).toBe(record.id);
    expect(tui.document.children[tui.chatIndex]).not.toBe(tui.originalChat);
    expect(tui.children[tui.pendingIndex]).toBe(tui.originalPending);
    expect(tui.children[tui.pendingIndex].render(120)).toEqual([]);
    expect(tui.children[tui.statusIndex]).toBe(tui.originalStatus);
    expect(tui.children[tui.statusIndex].render(120)).toEqual([]);
    expect(tui.children[tui.footerIndex]).toBe(tui.footerContainer);
    expect(tui.children[tui.footerIndex].render(120)).toEqual([]);
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
    expect(text).toContain("↑↓ Move");
    expect(text).toContain("● Explore");
    expect(text).toContain("Inspect the project");
    expect(navigator.handleTerminalInput("\x1b[A")).toEqual({ consume: true });
    expect(navigator.selectedId()).toBe(record.id);
    // Highlight moved to Main while the selected agent remains active (●).
    expect(selector.render(120).join("\n")).toContain("○ Main");
  });

  it("switches error views without mutating lifecycle state", () => {
    const record = makeRecord("agent-error", "error");
    record.execution.settled = true;
    record.error = "content was flagged";
    const manager = makeManager([record]) as any;
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(manager);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    expect(navigator.selectedId()).toBe(record.id);
    expect(record.lifecycle.status).toBe("error");

    navigator.handleTerminalInput("\x1b[A");
    navigator.handleTerminalInput("\r");
    expect(navigator.selectedId()).toBeNull();
    expect(record.lifecycle.status).toBe("error");
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
    expect(focused).toMatch(/○ \S+/);
    expect(focused).toContain("Inspect the project");
    expect(focused).toContain("↑↓ Move"); // focus hint while list-focused

    navigator.handleTerminalInput("\x1b");

    expect(navigator.selectedId()).toBeNull();
    expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);
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
    expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);
    expect(tui.children[tui.pendingIndex]).toBe(tui.originalPending);
    expect(tui.children[tui.pendingIndex].render(120)).toEqual(["parent pending"]);
    expect(tui.children[tui.statusIndex]).toBe(tui.originalStatus);
    expect(tui.children[tui.statusIndex].render(120)).toEqual(["parent status"]);
    expect(tui.children[tui.footerIndex]).toBe(tui.footerContainer);
    expect(tui.footerContainer.children).toEqual([tui.originalFooter]);
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
    const routeInput = vi.fn().mockResolvedValue({ accepted: true });
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

  it("renders interaction blocks on Main and restores counts after a successful retry", async () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    const routeInput = vi.fn()
      .mockResolvedValueOnce({
        accepted: false,
        reason: "concurrency",
        modelKey: "cliproxyapi/gpt-5.6-sol",
      })
      .mockResolvedValueOnce({ accepted: true });
    navigator = new AgentNavigator(makeManager([record]), routeInput);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    const editor = ui.editorFactory(makeTui(), {}, {});
    editor.onSubmit = vi.fn();

    (ui.baseEditor as any).onSubmit("continue the child");
    await vi.waitFor(() => {
      expect(selector.render(120).join("\n")).toContain(
        "Blocked: cliproxyapi/gpt-5.6-sol concurrency limit reached",
      );
    });
    expect(ui.ctx.setEditorText).toHaveBeenCalledWith("continue the child");
    expect(ui.ctx.notify).not.toHaveBeenCalledWith(
      "Selected subagent is not available for interaction",
      "warning",
    );

    (ui.baseEditor as any).onSubmit("retry");
    await vi.waitFor(() => {
      expect(selector.render(120).join("\n")).toContain("1 running · 1 total");
    });
    expect(editor).toBeDefined();
  });

  it("renders interaction blocks in the footer while the list is folded", async () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    const routeInput = vi.fn()
      .mockResolvedValueOnce({
        accepted: false,
        reason: "concurrency",
        modelKey: "cliproxyapi/gpt-5.6-sol",
      })
      .mockResolvedValueOnce({ accepted: true });
    navigator = new AgentNavigator(makeManager([record]), routeInput);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    navigator.toggleList();
    const editor = ui.editorFactory(makeTui(), {}, {});
    editor.onSubmit = vi.fn();

    (ui.baseEditor as any).onSubmit("continue the child");
    await vi.waitFor(() => {
      expect(ui.statuses.get("subagents-lite")).toContain(
        "Blocked: cliproxyapi/gpt-5.6-sol concurrency limit reached",
      );
    });
    expect(selector.render(120)).toEqual([]);
    expect(ui.statuses.get("subagents-lite")).toContain("Alt+A expand");
    expect(ui.statuses.get("subagents-lite")).toContain("Alt+M main");

    (ui.baseEditor as any).onSubmit("retry");
    await vi.waitFor(() => {
      expect(ui.statuses.get("subagents-lite")).toBe(
        "Subagent (1 running · 1 total · Alt+A expand · Alt+M main)",
      );
    });
  });

  it("ignores an older failed interaction after a newer success", async () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    let resolveFirst!: (result: any) => void;
    const first = new Promise<any>((resolve) => { resolveFirst = resolve; });
    const routeInput = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ accepted: true });
    navigator = new AgentNavigator(makeManager([record]), routeInput);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    const editor = ui.editorFactory(makeTui(), {}, {});
    editor.onSubmit = vi.fn();

    (ui.baseEditor as any).onSubmit("first");
    (ui.baseEditor as any).onSubmit("second");
    await vi.waitFor(() => expect(routeInput).toHaveBeenCalledTimes(2));
    ui.baseEditor.setText("new draft");
    resolveFirst({ accepted: false, reason: "concurrency", modelKey: "test/model" });
    await Promise.resolve();

    expect(selector.render(120).join("\n")).not.toContain("Blocked:");
    expect(ui.baseEditor.getText()).toBe("new draft");
  });

  it("ignores a failed interaction after switching back to Main", async () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    let resolveInteraction!: (result: any) => void;
    const pending = new Promise<any>((resolve) => { resolveInteraction = resolve; });
    navigator = new AgentNavigator(makeManager([record]), vi.fn(() => pending));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    const editor = ui.editorFactory(makeTui(), {}, {});
    editor.onSubmit = vi.fn();
    (ui.baseEditor as any).onSubmit("continue");

    navigator.handleTerminalInput("\x1b[A");
    navigator.handleTerminalInput("\r");
    ui.baseEditor.setText("main draft");
    resolveInteraction({ accepted: false, reason: "concurrency", modelKey: "test/model" });
    await Promise.resolve();

    expect(selector.render(120).join("\n")).not.toContain("Blocked:");
    expect(ui.baseEditor.getText()).toBe("main draft");
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

  it("shows queue waiting text before the child session exists", () => {
    const record = makeRecord();
    record.lifecycle.status = "queued";
    record.execution.session = undefined;
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    const text = tui.document.children[tui.chatIndex].render(120).join("\n");
    expect(text).toContain("Explore (Queued)");
    expect(text).not.toContain("agent-12");
    expect(text).toContain("Waiting in queue…");
    expect(text).not.toContain("Starting agent session…");
  });

  it("shows queued start failures when no child session was created", () => {
    const record = makeRecord();
    record.lifecycle.status = "error";
    record.execution.session = undefined;
    record.execution.settled = true;
    record.error = "Automatic model override is no longer authorized";
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    const text = tui.document.children[tui.chatIndex].render(120).join("\n");
    expect(text).toContain("Explore (Error)");
    expect(text).not.toContain("agent-12");
    expect(text).toContain("Error: Automatic model override is no longer authorized");
    expect(text).not.toContain("Starting agent session…");
  });

  it("uses the Error label in the selected subagent conversation", () => {
    const record = makeRecord();
    record.lifecycle.status = "error";
    record.execution.settled = true;
    record.error = "503 service unavailable";
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    const lines = tui.document.children[tui.chatIndex].render(120);
    const text = lines.join("\n");
    expect(text).toContain("Explore (Error)");
    expect(text).not.toContain("agent-12");
    expect(text).toContain("Inspect the project");
    expect(text).toContain("I should inspect files.");
    expect(text).toContain("read");
    expect(text).toContain("I found the project structure.");
    expect(text).toContain("# Project");
    expect(ui.widgets.has("agent-navigator-transcript")).toBe(false);
  });

  it.each(["regular", "fullscreen"] as const)("reuses unchanged transcript content while typing in %s mode", (mode) => {
    const record = makeRecord();
    const session = record.execution.session;
    const readHistory = vi.fn((index: number) => [
      { type: "text", text: `Synthetic history ${index}. ${"Sample output. ".repeat(40)}` },
    ]);
    session.messages = Array.from({ length: 200 }, (_, index) => ({
      role: "assistant",
      get content() { return readHistory(index); },
    }));
    const liveText = { type: "text", text: "Partial answer" };
    const readStreaming = vi.fn(() => [liveText]);
    const streamingMessage = { role: "assistant", get content() { return readStreaming(); } };
    session.agent.state.streamingMessage = streamingMessage;
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    const fixture = makeSwitchableTui();
    fixture.switchMode(mode);
    const { tui } = mountSelector(ui, fixture.tui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    fixture.renderCurrent();
    readHistory.mockClear();
    readStreaming.mockClear();
    const editor = tui.children[tui.editorIndex].children[0];
    for (const key of "draft") {
      editor.handleInput(key);
      expect(fixture.renderCurrent().join("\n")).toContain("Partial answer");
    }
    expect(ui.baseEditor.handleInput).toHaveBeenCalledTimes(5);
    expect(readHistory).not.toHaveBeenCalled();
    expect(readStreaming).not.toHaveBeenCalled();
    expect(session.subscribe).toHaveBeenCalledOnce();

    liveText.text = "Updated partial answer";
    const onEvent = session.subscribe.mock.calls[0][0];
    onEvent({ type: "message_update", message: streamingMessage });
    expect(fixture.renderCurrent().join("\n")).toContain("Updated partial answer");
    expect(readStreaming).toHaveBeenCalled();
    expect(readHistory).not.toHaveBeenCalled();

    session.messages.push(streamingMessage);
    session.agent.state.streamingMessage = undefined;
    onEvent({ type: "message_end", message: streamingMessage });
    const text = fixture.renderCurrent().join("\n");
    expect(text.match(/Updated partial answer/g)).toHaveLength(1);
    expect(text).toContain("Synthetic history 199.");
    expect(readHistory).not.toHaveBeenCalled();
  });

  it("refreshes message edits and lifecycle metadata when a message ends", () => {
    const record = makeRecord();
    const session = record.execution.session;
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    const { tui } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    const transcript = tui.document.children[tui.chatIndex];
    transcript.render(120);

    const message = session.messages[1];
    message.content[2].text = "Revised synthetic answer";
    session.subscribe.mock.calls[0][0]({ type: "message_end", message });
    record.lifecycle.status = "error";
    record.error = "Synthetic completion error";
    const text = transcript.render(120).join("\n");
    expect(text).toContain("Revised synthetic answer");
    expect(text).not.toContain("I found the project structure.");
    expect(text).toContain("Explore (Error)");
    expect(text).toContain("Error: Synthetic completion error");
  });

  it.each(["history", "session"])("rebuilds a replaced %s with the same message count", (replacement) => {
    const record = makeRecord();
    const session = record.execution.session;
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    const { tui } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    const transcript = tui.document.children[tui.chatIndex];
    transcript.render(120);
    const unsubscribe = session.subscribe.mock.results[0].value;

    const messages = Array.from({ length: session.messages.length }, (_, index) => ({
      role: "compactionSummary",
      summary: `Synthetic compacted history ${index}`,
    }));
    if (replacement === "history") session.messages = messages;
    else record.execution.session = { ...session, messages, subscribe: vi.fn(() => vi.fn()) };

    const text = transcript.render(120).join("\n");
    expect(text).toContain("Synthetic compacted history 0");
    expect(text).not.toContain("I found the project structure.");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("reflows cached messages on resize and refreshes them on theme invalidation", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    const { tui } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    const transcript = tui.document.children[tui.chatIndex];
    const wide = transcript.render(120);
    const narrow = transcript.render(24);
    expect(narrow.length).toBeGreaterThan(wide.length);
    expect(narrow.every((line: string) => stripAnsi(line).length <= 24)).toBe(true);

    const nextTheme = makeTheme();
    nextTheme.bold.mockImplementation((text: string) => `Styled ${text}`);
    Object.defineProperty(ui.ctx, "theme", { value: nextTheme });
    expect(transcript.render(24).join("\n")).toContain("Styled Assistant");

    nextTheme.bold.mockImplementation((text: string) => `Updated ${text}`);
    transcript.invalidate();
    expect(transcript.render(24).join("\n")).toContain("Updated Assistant");
  });

  it.each(["main", "context", "dispose"])("releases transcript subscriptions on %s transitions", (transition) => {
    const record = makeRecord();
    const session = record.execution.session;
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    const { tui } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    tui.document.children[tui.chatIndex].render(120);
    const unsubscribe = session.subscribe.mock.results[0].value;

    if (transition === "main") navigator.activateMain();
    else if (transition === "context") navigator.setUICtx(makeUI({ value: "" }).ctx as any);
    else navigator.dispose();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(session.subscribe).toHaveBeenCalledOnce();
  });

  it("removes built-in Main footer data while preserving extension statuses", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const tui = makeTui();
    tui.originalFooter.render = () => [
      "parent cwd",
      "parent stats",
      "Subagent (Alt+A collapse · Alt+M main)",
    ];
    mountSelector(ui, tui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    expect(tui.footerContainer.render(120)).toEqual([
      "Subagent (Alt+A collapse · Alt+M main)",
    ]);
  });

  it("preserves a same-named custom footer while a subagent is selected", () => {
    class FooterComponent {
      render(): string[] {
        return ["custom row 1", "custom row 2", "custom row 3"];
      }
      invalidate(): void {}
    }

    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const tui = makeTui();
    tui.footerContainer.children = [new FooterComponent()];
    mountSelector(ui, tui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    expect(tui.footerContainer.render(120)).toEqual([
      "custom row 1",
      "custom row 2",
      "custom row 3",
    ]);
  });

  it("keeps a footer replaced by another extension while Main is selected", () => {
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
    tui.footerContainer.children = [replacementFooter];

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[A");
    navigator.handleTerminalInput("\r");

    expect(tui.footerContainer.children).toEqual([replacementFooter]);
    expect(tui.footerContainer.render(120)).toEqual(["replacement cwd", "replacement stats"]);
  });

  it("renders a footer replaced by another extension on the child screen", () => {
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
    tui.footerContainer.children = [replacementFooter];

    expect(tui.footerContainer.render(120)).toEqual(["replacement cwd", "replacement stats"]);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[A");
    navigator.handleTerminalInput("\r");
    expect(tui.footerContainer.children).toEqual([replacementFooter]);
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

  it("keeps refresh timer running while any agent is unsettled even if status is not running or queued", () => {
    const record = makeRecord("agent-unsettled", "error");
    record.execution.settled = false;
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);

    expect((navigator as any).refreshTimer).toBeDefined();

    record.execution.settled = true;
    navigator.update();

    expect((navigator as any).refreshTimer).toBeUndefined();
  });

  it("starts refresh timer in setUICtx when active agents are present and skips when absent", () => {
    const activeRecord = makeRecord("agent-active", "running");
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([activeRecord]));
    navigator.setUICtx(ui.ctx as any);

    expect((navigator as any).refreshTimer).toBeDefined();

    navigator.dispose();

    const completedRecord = makeRecord("agent-completed", "completed");
    completedRecord.execution.settled = true;
    navigator = new AgentNavigator(makeManager([completedRecord]));
    navigator.setUICtx(ui.ctx as any);

    expect((navigator as any).refreshTimer).toBeUndefined();
  });

  it("removes the Main shortcut hint when the active record disappears", () => {
    const active = makeRecord("agent-active");
    const remaining = makeRecord("agent-remaining", "completed");
    const records = [active, remaining];
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager(records));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    expect(selector.render(120).join("\n")).toContain("Alt+M main");

    records.shift();
    navigator.update();

    expect(navigator.selectedId()).toBeNull();
    expect(selector.render(120).join("\n")).not.toContain("Alt+M main");
    expect(ui.statuses.has("subagents-lite")).toBe(false);
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
    expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);
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

    expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);
    expect(tui.children[tui.footerIndex]).toBe(tui.footerContainer);
    expect(tui.footerContainer.children).toEqual([tui.originalFooter]);
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

  it("keeps the active child and dynamic footer across Pi 0.84 renderer switches", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const fixture = makeSwitchableTui();
    mountSelector(ui, fixture.tui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    expect(navigator.selectedId()).toBe(record.id);
    let text = fixture.renderCurrent().join("\n");
    expect(text).toContain("Explore (Running)");
    expect(text).not.toContain("parent chat");
    expect(text).not.toContain("parent pending");
    expect(text).not.toContain("parent status");
    expect(text).not.toContain("parent cwd");
    expect(text).not.toContain("parent stats");

    fixture.switchMode("fullscreen");
    expect(fixture.tui.mode).toBe("fullscreen");
    text = fixture.renderCurrent().join("\n");
    expect(text).toContain("Explore (Running)");
    expect(text).not.toContain("parent pending");
    expect(text).not.toContain("parent status");
    expect(text).not.toContain("parent cwd");
    expect(text).not.toContain("parent stats");

    const replacementFooter = {
      render: () => ["replacement footer"],
      invalidate: vi.fn(),
    };
    fixture.tui.footerContainer.children = [replacementFooter];
    expect(fixture.renderCurrent().join("\n")).toContain("replacement footer");

    fixture.switchMode("regular");
    expect(fixture.tui.mode).toBe("regular");
    expect(fixture.renderCurrent().join("\n")).toContain("replacement footer");
    expect(navigator.selectedId()).toBe(record.id);

    navigator.handleTerminalInput("\x1b[A");
    navigator.handleTerminalInput("\r");

    expect(navigator.selectedId()).toBeNull();
    text = fixture.renderCurrent().join("\n");
    expect(text).toContain("parent chat");
    expect(text).toContain("parent pending");
    expect(text).toContain("parent status");
    expect(text).toContain("replacement footer");
    expect(fixture.regular.children).toHaveLength(7);
    expect(fixture.fullscreen.children).toHaveLength(0);
  });

  it("rejects a document container with an unexpected child count", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const tui = makeTui();
    tui.document.children.push(makeContainer("unexpected document region"));
    mountSelector(ui, tui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    expect(navigator.selectedId()).toBeNull();
    expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);
    expect(ui.ctx.notify).toHaveBeenCalledWith(
      "Subagent screen switching is unavailable: unsupported Pi TUI layout",
      "warning",
    );
  });

  it("rejects a document whose chat child is not a container", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const tui = makeTui();
    const invalidChat = makeComponent("invalid chat");
    tui.document.children[tui.chatIndex] = invalidChat;
    mountSelector(ui, tui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    expect(navigator.selectedId()).toBeNull();
    expect(tui.document.children[tui.chatIndex]).toBe(invalidChat);
    expect(ui.ctx.notify).toHaveBeenCalledWith(
      "Subagent screen switching is unavailable: unsupported Pi TUI layout",
      "warning",
    );
  });

  it.each(["pending", "status", "footer"] as const)(
    "rejects switching after another extension replaces the %s render method",
    (region) => {
      const record = makeRecord();
      const ui = makeUI({ value: "" });
      navigator = new AgentNavigator(makeManager([record]));
      navigator.setUICtx(ui.ctx as any);
      navigator.ensureTimer();
      const tui = makeTui();
      mountSelector(ui, tui);
      const originalPendingRender = tui.originalPending.render;
      const originalStatusRender = tui.originalStatus.render;
      const originalFooterRender = tui.footerContainer.render;
      const container = region === "pending"
        ? tui.originalPending
        : region === "status"
          ? tui.originalStatus
          : tui.footerContainer;
      const replacementRender = () => [`replacement ${region}`];
      container.render = replacementRender;

      navigator.handleTerminalInput("\x1b[B");
      navigator.handleTerminalInput("\x1b[B");
      navigator.handleTerminalInput("\r");

      expect(navigator.selectedId()).toBeNull();
      expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);
      expect(tui.originalPending.render).toBe(
        region === "pending" ? replacementRender : originalPendingRender,
      );
      expect(tui.originalStatus.render).toBe(
        region === "status" ? replacementRender : originalStatusRender,
      );
      expect(tui.footerContainer.render).toBe(
        region === "footer" ? replacementRender : originalFooterRender,
      );
      expect(tui.footerContainer.children).toEqual([tui.originalFooter]);
      expect(ui.ctx.notify).toHaveBeenCalledWith(
        "Subagent screen switching is unavailable: unsupported Pi TUI layout",
        "warning",
      );
    },
  );

  it("rejects an unknown root region inserted between status and widgets", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const tui = makeTui();
    tui.children.splice(tui.statusIndex + 1, 0, makeContainer("unknown region"));
    tui.editorIndex += 1;
    tui.belowIndex += 1;
    mountSelector(ui, tui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    expect(navigator.selectedId()).toBeNull();
    expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);
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

  it("omits empty or whitespace-only thinking blocks and trailing blank assistant headers", () => {
    const record = makeRecord();
    const session = record.execution.session;
    session.messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Valid thought process" },
          { type: "text", text: "Answer with trailing empty thinking" },
          { type: "thinking", thinking: "   \n\t  " },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "" },
        ],
      },
    ];
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    const { tui } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    const transcript = tui.document.children[tui.chatIndex];
    const lines = transcript.render(120);
    const renderedText = lines.join("\n");

    expect(renderedText).toContain("Valid thought process");
    expect(renderedText).toContain("Answer with trailing empty thinking");
    expect(renderedText.match(/Thinking/g)).toHaveLength(1);
    expect(renderedText.match(/Assistant/g)).toHaveLength(1);
  });

  it("highlights focused rows with selectedBg and renders pin badges cleanly", () => {
    const r1 = makeRecord("agent-1");
    r1.lifecycle.pinnedAt = Date.now();
    const r2 = makeRecord("agent-2");
    const ui = makeUI({ value: "" });
    ui.theme.bg = vi.fn((color: string, text: string) => `[bg:${color}]${text}[/bg]`);
    navigator = new AgentNavigator(makeManager([r1, r2]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    // Focus Main
    navigator.handleTerminalInput("\x1b[B");
    let lines = selector.render(120);
    expect(lines.find((l: string) => l.includes("Main"))).toContain("[bg:selectedBg]");

    // Focus agent-1 (pinned)
    navigator.handleTerminalInput("\x1b[B");
    lines = selector.render(120);
    const agent1Line = lines.find((l: string) => l.includes("agent-1") || l.includes("Explore"))!;
    expect(agent1Line).toContain("[bg:selectedBg]");
    expect(agent1Line).toContain("◆");
    expect(agent1Line).not.toContain("›");
  });

  it("preserves selectedBg background color across inner ANSI SGR resets", () => {
    const record = makeRecord("agent-long");
    record.display.description = "A".repeat(200); // Guarantees truncation with ellipsis and SGR reset
    const ui = makeUI({ value: "" });
    ui.theme.bg = vi.fn((_color: string, text: string) => `\x1b[44m${text}\x1b[49m`);
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B"); // Focus Main
    navigator.handleTerminalInput("\x1b[B"); // Focus agent-long
    const lines = selector.render(120);
    const highlightedRow = lines.find((l: string) => l.includes("Explore"))!;
    expect(highlightedRow).toContain("\x1b[44m");
    // Ensure every \x1b[0m has the background code re-asserted immediately
    expect(highlightedRow).not.toMatch(/\x1b\[0m(?!\x1b\[44m)/);
  });
});
