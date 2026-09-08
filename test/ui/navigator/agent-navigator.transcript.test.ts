/**
 * agent-navigator.transcript.test.ts — Subagent conversation transcript & footer tests.
 *
 * Covers:
 *   - Subagent conversation transcript rendering (queued, running, error)
 *   - Live streaming updates & token reflow on resize
 *   - Subscription cleanup on screen switches and disposal
 *   - Child footer customization & extension footer preservation
 *   - Control character sanitization (BEL \x07)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "../../harness.js";
import { AgentNavigator } from "../../../src/ui/agent-navigator.js";
import {
  makeRecord,
  makeManager,
  makeUI,
  makeTui,
  makeSwitchableTui,
  makeTheme,
  makeComponent,
  makeContainer,
  mountSelector,
  stripAnsi,
} from "./navigator-test-helpers.js";

describe("AgentNavigator — Transcript & Footer", () => {
  let navigator: AgentNavigator | undefined;
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
    navigator = undefined;
    harness.onDispose(() => navigator?.dispose());
  });

  afterEach(async () => { await harness.dispose(); });

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
    expect(text).toContain("Waiting in queue…");
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
    expect(text).toContain("Error: Automatic model override is no longer authorized");
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
    expect(text).toContain("Inspect the project");
    expect(text).toContain("read");
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
    expect(text).toContain("Explore (Error)");
    expect(text).toContain("Error: Synthetic completion error");
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

  it("sanitizes BEL (\\x07) and control characters from transcript rendering", () => {
    const record = makeRecord("agent-bel");
    record.execution.session.messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Bell \x07 sound and \x1b[31mRed\x1b[0m text" }],
      },
    ];
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    const { tui } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    const rendered = tui.document.children[tui.chatIndex].render(120).join("\n");
    expect(rendered).not.toContain("\x07");
    expect(rendered).toContain("Bell");
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
});
