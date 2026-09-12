import { projectMessage } from "../../src/drivers/message-projection.js";
import type { NavigationAction } from "../../src/ui/navigation.js";
import type { ExecutionMessage } from "../../src/engine/contracts.js";
/**
 * Shared fixtures and helpers for AgentNavigator tests.
 */

import { vi } from "vitest";
import { ScrollView, VStack } from "@earendil-works/pi-tui";

export interface MockEditor {
  getText: () => string;
  setText: (text: string) => void;
  handleInput: (data: string) => void;
  onSubmit?: (text: string) => void;
  onEscape?: () => void;
  wantsKeyRelease: boolean;
  actionHandlers: Map<string, () => void>;
  addToHistory: ReturnType<typeof vi.fn>;
  render: () => string[];
  invalidate: ReturnType<typeof vi.fn>;
}

export function makeRecord(id = "agent-12345678", status = "running"): any {
  return {
    id,
    display: {
      type: "Explore",
      name: "Explore",
      description: "Inspect the project",
    },
    lifecycle: {
      status,
      startedAt: Date.now(),
    },
    execution: {
      operationId: id,
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

export function makeSource(records: any[]): any {
  const cache = new WeakMap<object, ExecutionMessage>();
  let sequence = 0;
  const subscriptions = new Map<string, () => void>();
  const project = (message: any) => {
    let result = cache.get(message);
    if (!result) { result = projectMessage(String(++sequence), message); cache.set(message, result); }
    return result;
  };
  const source: any = {
    togglePinned: vi.fn(), abort: vi.fn(() => true), abortRetry: vi.fn(() => false),
    dequeueMessages: vi.fn(() => []), clear: vi.fn(() => false), sendInput: vi.fn(async () => ({ accepted: true })),
    takeOver: vi.fn((id: string) => { const record = records.find(record => record.id === id); if (record) record.lifecycle.takenOver = true; return !!record; }),
    getRecord: (id: string) => {
      const record = records.find(record => record.id === id);
      if (!record) return;
      const frame = record.execution.session;
      const queued = [...(frame?.getSteeringMessages?.() ?? []).map((text: string) => ({ kind: "steer", input: { text } })),
        ...(frame?.getFollowUpMessages?.() ?? []).map((text: string) => ({ kind: "followUp", input: { text } })),
        ...(record.execution.pendingSteers ?? []).map((item: any) => ({ kind: item.kind ?? "steer", input: { text: item.message, images: item.images } }))];
      return { ...record, operationId: record.execution.operationId ?? id,
        display: { ...record.display, name: record.display.name ?? record.display.type },
        execution: { ...record.execution, settled: record.execution.settled ?? !["running", "queued"].includes(record.lifecycle.status),
          providerName: frame?.model?.provider ?? record.display.invocation?.providerName,
          modelName: frame?.model?.id ?? record.display.invocation?.modelName,
          thinkingLevel: frame?.thinkingLevel ?? record.display.invocation?.thinkingLevel },
        queued: queued.map((item: any, index: number) => ({ ...item, entryId: String(index) })),
        canDeliver: !!record.lifecycle.takenOver && !!(record.result?.trim() || frame?.messages.some((message: any) =>
          ["user", "assistant"].includes(message.role) && project(message).text.trim())),
      };
    },
    listAgents: () => records.map(record => source.getRecord(record.id)),
    transcript: (id: string) => {
      const record = records.find(record => record.id === id);
      const frame = record?.execution.session;
      const messages = frame?.messages.map(project) ?? [];
      if (record?.result && !messages.some((message: ExecutionMessage) => ["user", "assistant"].includes(message.role) && message.text.trim())) {
        messages.push({ entryId: id + ":result", role: "assistant", text: record.result });
      }
      return { ready: !!frame || !!record?.result, messages, streaming: frame?.agent.state.streamingMessage ? project(frame.agent.state.streamingMessage) : undefined };
    },
    watchTranscript: (id: string, listener: () => void) => {
      const stop = records.find(record => record.id === id)?.execution.session?.subscribe((event: any) => {
        if (event.message) cache.delete(event.message);
        listener();
      });
      const unsubscribe = () => { stop?.(); subscriptions.delete(id); };
      subscriptions.set(id, unsubscribe);
      return unsubscribe;
    },
    subscribe: () => () => {},
    dispatch: (action: NavigationAction) => {
      if (action.type === "deliver") return { accepted: true, deliveryId: action.deliveryId ?? "selection" };
      switch (action.type) {
        case "takeover": return { accepted: source.takeOver(action.taskId) };
        case "pin": return { accepted: true, pinned: source.togglePinned(action.taskId) };
        case "abort": return { accepted: source.abort(action.taskId, "user") };
        case "abortRetry": return { accepted: source.abortRetry(action.taskId) };
        case "remove": return { accepted: source.clear(action.taskId, "user") };
        case "dequeue": return { accepted: true, restored: source.dequeueMessages(action.taskId).map((text: string) => ({ text })) };
        case "steer": case "followUp": case "continue": return source.sendInput(action.taskId, action.input.text, action.input.images, action.type);
      }
    },
    dispose: () => { for (const stop of [...subscriptions.values()]) stop(); },
  };
  return source;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function makeTheme(): any {
  return {
    fg: vi.fn((_color: string, text: string) => text),
    bold: vi.fn((text: string) => text),
  };
}

export function makeComponent(text: string): any {
  return {
    render: () => [text],
    invalidate: vi.fn(),
  };
}

export function makeContainer(text: string): any {
  return {
    children: [makeComponent(text)],
    render: () => [text],
    invalidate: vi.fn(),
  };
}

export function makeChatContainer(text: string): any {
  return {
    children: [makeComponent(text)],
    render: () => [text],
    invalidate: vi.fn(),
  };
}

export function makeLiveContainer(children: any[]): any {
  return {
    children,
    render(width: number) {
      return this.children.flatMap((child: any) => child.render(width));
    },
    invalidate: vi.fn(),
  };
}

export function makeTui(mode: "regular" | "fullscreen" = "regular"): any {
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

export function makeSwitchableTui() {
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

export function makeUI(editorText: { value: string }) {
  const widgets = new Map<string, any>();
  const statuses = new Map<string, string>();
  const theme = makeTheme();
  const baseEditor: MockEditor = {
    getText: () => editorText.value,
    setText: (text: string) => { editorText.value = text; },
    handleInput: vi.fn((data: string) => {
      if (data === "\r" || data === "\n") {
        baseEditor.onSubmit?.(editorText.value);
      }
    }),
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

export function mountSelector(ui: ReturnType<typeof makeUI>, tui = makeTui(), keybindings: unknown = {}): any {
  const selectorFactory = ui.widgets.get("agent-navigator-selector");
  if (!selectorFactory) throw new Error("agent-navigator-selector widget is not mounted");
  const selector = selectorFactory(tui, ui.theme);
  const editor = ui.editorFactory(tui, {}, keybindings);
  const editorContainer = tui.children[tui.editorIndex];
  if (editorContainer?.children) editorContainer.children = [editor];
  const below = tui.children[tui.belowIndex];
  if (below?.children) below.children.push(selector);
  selector.render(120);
  return { tui, selector };
}
