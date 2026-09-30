/**
 * agent-navigator.input.test.ts — Keyboard input and focus tests for AgentNavigator.
 *
 * Covers:
 *   - Focus movement (arrows, Enter, Esc, Ctrl+C)
 *   - Continuous navigation across subagent and Main views
 *   - Paste handling & focus release
 *   - Mouse click switching, wheel navigation & hidden-row paging
 *   - Highlight state tracking via public highlightedId() API
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { createTestHarness, type TestHarness } from "../../../support/harness.js";
import { AgentNavigator } from "../../../../src/ui/agent-navigator.js";
import {
  makeRecord,
  makeSource,
  makeUI,
  makeTui,
  mountSelector,
} from "../../../support/navigator.js";

describe("AgentNavigator — Keyboard Input & Focus", () => {
  let navigator: AgentNavigator | undefined;
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
    navigator = undefined;
    harness.onDispose(() => navigator?.dispose());
  });

  afterEach(async () => { await harness.dispose(); });

  it("suppresses the editor cursor marker while list navigation owns focus", () => {
    const ui = makeUI({ value: "" });
    ui.baseEditor.render = () => [`Draft${CURSOR_MARKER}`];
    navigator = new AgentNavigator(makeSource([makeRecord()]));
    navigator.setUICtx(ui.ctx as any);
    const { tui } = mountSelector(ui);
    const editor = tui.children[tui.editorIndex].children[0];
    expect(editor.render(120).join("")).toContain(CURSOR_MARKER);
    editor.handleInput("\x1b[B");
    expect(navigator.isListFocused()).toBe(true);
    expect(editor.render(120).join("")).not.toContain(CURSOR_MARKER);
    editor.handleInput("\x1b");
    expect(editor.render(120).join("")).toContain(CURSOR_MARKER);
  });

  it("requires Enter before changing the active agent", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeSource([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B"); // focus Main
    navigator.handleTerminalInput("\x1b[B"); // highlight subagent
    expect(navigator.highlightedId()).toBe(record.id);
    expect(navigator.selectedId()).toBeNull();
    expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);

    navigator.handleTerminalInput("\r");
    expect(navigator.selectedId()).toBe(record.id);
    expect(tui.children[tui.pendingIndex].render(120)).toEqual([]);
    expect(tui.children[tui.statusIndex].render(120)).toEqual([]);
    expect(tui.footerContainer.render(120)).toEqual([]);
    expect(tui.terminal.write).toHaveBeenCalledWith("\x1b[3J");
  });

  it("keeps the selected agent focused after confirmation", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeSource([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    expect(navigator.selectedId()).toBe(record.id);
    expect(navigator.highlightedId()).toBe(record.id);
  });

  it("Escape cancels a highlighted candidate without switching", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeSource([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    expect(navigator.highlightedId()).toBe(record.id);

    navigator.handleTerminalInput("\x1b");
    expect(navigator.selectedId()).toBeNull();
    expect(navigator.isListFocused()).toBe(false);
  });

  it("does not enter the selector when the editor contains text", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "draft text" });
    navigator = new AgentNavigator(makeSource([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);

    const res = navigator.handleTerminalInput("\x1b[B");
    expect(res).toBeUndefined();
    expect(navigator.isListFocused()).toBe(false);
  });

  it("submits to Main when pressing Enter on active Main row with non-empty text", () => {
    const record = makeRecord("agent-1");
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeSource([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);
    const editor = ui.editorFactory(makeTui(), {}, {});
    const parentSubmit = vi.fn();
    editor.onSubmit = parentSubmit;

    navigator.handleTerminalInput("\x1b[B");
    expect(navigator.isListFocused()).toBe(true);
    expect(navigator.selectedId()).toBeNull();

    ui.baseEditor.setText("Hello Main");
    const inputSpy = vi.spyOn(navigator, "handleTerminalInput");
    const baseSubmitSpy = vi.fn(ui.baseEditor.onSubmit);
    ui.baseEditor.onSubmit = baseSubmitSpy;

    editor.handleInput("\r");

    expect(inputSpy).toHaveReturnedWith(undefined);
    expect(navigator.isListFocused()).toBe(false);
    expect(baseSubmitSpy).toHaveBeenCalledWith("Hello Main");
    expect(parentSubmit).toHaveBeenCalledWith("Hello Main");
  });

  it("submits to active subagent via routeInput when pressing Enter with non-empty text", () => {
    const record = makeRecord("agent-1");
    const ui = makeUI({ value: "" });
    const routeInput = vi.fn().mockResolvedValue({ accepted: true });
    navigator = new AgentNavigator(makeSource([record]), routeInput);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);
    const editor = ui.editorFactory(makeTui(), {}, {});
    const parentSubmit = vi.fn();
    editor.onSubmit = parentSubmit;

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    expect(navigator.selectedId()).toBe("agent-1");
    expect(navigator.isListFocused()).toBe(true);
    expect(navigator.highlightedId()).toBe("agent-1");

    ui.baseEditor.setText("Fix this bug");
    const inputSpy = vi.spyOn(navigator, "handleTerminalInput");
    editor.handleInput("\r");

    expect(inputSpy).toHaveReturnedWith(undefined);
    expect(navigator.isListFocused()).toBe(false);
    expect(routeInput).toHaveBeenCalledWith({ type: "steer", taskId: "agent-1", operationId: "agent-1", input: { text: "Fix this bug" } });
    expect(parentSubmit).not.toHaveBeenCalled();
  });

  it("switches to Main on Enter from subagent view without sending message", () => {
    const record = makeRecord("agent-1");
    const ui = makeUI({ value: "" });
    const routeInput = vi.fn().mockResolvedValue({ accepted: true });
    navigator = new AgentNavigator(makeSource([record]), routeInput);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);
    const editor = ui.editorFactory(makeTui(), {}, {});
    const parentSubmit = vi.fn();
    editor.onSubmit = parentSubmit;

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    expect(navigator.selectedId()).toBe("agent-1");

    navigator.handleTerminalInput("\x1b[A");
    expect(navigator.highlightedId()).toBeNull();

    ui.baseEditor.setText("Draft for main");
    const inputSpy = vi.spyOn(navigator, "handleTerminalInput");
    editor.handleInput("\r");

    expect(inputSpy).toHaveReturnedWith({ consume: true });
    expect(navigator.selectedId()).toBeNull();
    expect(routeInput).not.toHaveBeenCalled();
    expect(parentSubmit).not.toHaveBeenCalled();
    expect(ui.baseEditor.getText()).toBe("Draft for main");
    expect(navigator.isListFocused()).toBe(false);

    editor.handleInput("\r");
    expect(parentSubmit).toHaveBeenCalledWith("Draft for main");
    expect(routeInput).not.toHaveBeenCalled();
  });

  it("switches to subagent on Enter from Main without sending message", () => {
    const record1 = makeRecord("agent-1");
    const record2 = makeRecord("agent-2");
    const ui = makeUI({ value: "" });
    const routeInput = vi.fn().mockResolvedValue({ accepted: true });
    navigator = new AgentNavigator(makeSource([record1, record2]), routeInput);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);
    const editor = ui.editorFactory(makeTui(), {}, {});
    const parentSubmit = vi.fn();
    editor.onSubmit = parentSubmit;

    navigator.handleTerminalInput("\x1b[B"); // focus Main
    navigator.handleTerminalInput("\x1b[B"); // highlight agent-1
    navigator.handleTerminalInput("\x1b[B"); // highlight agent-2
    expect(navigator.highlightedId()).toBe("agent-2");

    ui.baseEditor.setText("Task for agent 2");
    const inputSpy = vi.spyOn(navigator, "handleTerminalInput");
    editor.handleInput("\r");

    expect(inputSpy).toHaveReturnedWith({ consume: true });
    expect(navigator.selectedId()).toBe("agent-2");
    expect(routeInput).not.toHaveBeenCalled();
    expect(parentSubmit).not.toHaveBeenCalled();
    expect(ui.baseEditor.getText()).toBe("Task for agent 2");
    expect(navigator.isListFocused()).toBe(false);
  });

  it("preserves continuous keyboard navigation and list focus across switches with empty editor", () => {
    const record1 = makeRecord("agent-1");
    const record2 = makeRecord("agent-2");
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeSource([record1, record2]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);
    const editor = ui.editorFactory(makeTui(), {}, {});

    navigator.handleTerminalInput("\x1b[B"); // Main
    navigator.handleTerminalInput("\x1b[B"); // agent-1
    editor.handleInput("\r");
    expect(navigator.selectedId()).toBe("agent-1");
    expect(navigator.isListFocused()).toBe(true);

    navigator.handleTerminalInput("\x1b[B"); // agent-2
    expect(navigator.highlightedId()).toBe("agent-2");
    editor.handleInput("\r");
    expect(navigator.selectedId()).toBe("agent-2");
    expect(navigator.isListFocused()).toBe(true);

    navigator.handleTerminalInput("\x1b[A"); // agent-1
    navigator.handleTerminalInput("\x1b[A"); // Main
    expect(navigator.highlightedId()).toBeNull();
    editor.handleInput("\r");
    expect(navigator.selectedId()).toBeNull();
    expect(navigator.isListFocused()).toBe(true);
  });

  it.each([
    { input: "pasted text", focused: false },
    { input: "\x1b[200~pasted code\x1b[201~", focused: false },
    { input: "\x1b[C", focused: true },
  ])("routes paste and navigation escapes to the editor: $input", ({ input, focused }) => {
    const record = makeRecord("agent-1");
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeSource([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    expect(navigator.isListFocused()).toBe(true);

    expect(navigator.handleTerminalInput(input)).toBeUndefined();
    expect(navigator.isListFocused()).toBe(focused);
  });

  it("Ctrl+D then Enter clears inactive subagents and moves the highlight", () => {
    const r1 = makeRecord("agent-11111111");
    const r2 = makeRecord("agent-22222222");
    const records = [r1, r2];
    const ui = makeUI({ value: "" });
    const manager = makeSource(records) as any;
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

  it("passes through Ctrl+C and cancels clear confirmation", () => {
    const record = makeRecord("agent-11111111");
    const secondRecord = makeRecord("agent-22222222");
    const ui = makeUI({ value: "" });
    const manager = makeSource([record, secondRecord]) as any;
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

  it("switches to subagent on mouse click and restores Main on clicking Main", () => {
    const record = makeRecord("agent-11111111");
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeSource([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);

    // Initially at Main (selectedId is null, list not focused).
    // Row 0 is Main, Row 1 is subagent-1.
    expect(navigator.selectedId()).toBeNull();
    expect(navigator.isListFocused()).toBe(false);

    // Click subagent-1 (Row 1).
    const pressResult = selector.handleMouse({
      type: "press", button: "left", x: 2, y: 1, screenX: 2, screenY: 1, width: 120, height: 10, shift: false, alt: false, ctrl: false,
    });
    expect(pressResult).toEqual({ handled: true });

    const clickResult = selector.handleMouse({
      type: "click", button: "left", x: 2, y: 1, screenX: 2, screenY: 1, width: 120, height: 10, shift: false, alt: false, ctrl: false,
    });
    expect(clickResult).toEqual({ handled: true, render: true });
    expect(navigator.selectedId()).toBe(record.id);
    expect(navigator.highlightedId()).toBe(record.id);
    expect(navigator.isListFocused()).toBe(true);
    expect(tui.document.children[tui.chatIndex]).not.toBe(tui.originalChat);

    // With listFocused=true: Row 0 is Command bar, Row 1 is Main, Row 2 is subagent-1.
    // Click Main (Row 1).
    const clickMain = selector.handleMouse({
      type: "click", button: "left", x: 2, y: 1, screenX: 2, screenY: 1, width: 120, height: 10, shift: false, alt: false, ctrl: false,
    });
    expect(clickMain).toEqual({ handled: true, render: true });
    expect(navigator.selectedId()).toBeNull();
    expect(navigator.highlightedId()).toBeNull();
    expect(tui.document.children[tui.chatIndex]).toBe(tui.originalChat);
  });

  it("supports mouse wheel navigation and ignores unhandled buttons", () => {
    const record1 = makeRecord("agent-11111111");
    const record2 = makeRecord("agent-22222222");
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeSource([record1, record2]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    // Ignore right clicks or move events.
    expect(selector.handleMouse({
      type: "press", button: "right", x: 2, y: 1, screenX: 2, screenY: 1, width: 120, height: 10, shift: false, alt: false, ctrl: false,
    })).toBeUndefined();
    expect(selector.handleMouse({
      type: "move", button: "none", x: 2, y: 1, screenX: 2, screenY: 1, width: 120, height: 10, shift: false, alt: false, ctrl: false,
    })).toBeUndefined();

    // Wheel down moves highlight to first subagent.
    const wheel1 = selector.handleMouse({
      type: "wheel", button: "none", wheelDelta: 1, x: 2, y: 0, screenX: 2, screenY: 0, width: 120, height: 10, shift: false, alt: false, ctrl: false,
    });
    expect(wheel1).toEqual({ handled: true, render: true });
    expect(navigator.highlightedId()).toBe(record1.id);
    expect(navigator.isListFocused()).toBe(true);

    // Wheel down moves highlight to second subagent.
    const wheel2 = selector.handleMouse({
      type: "wheel", button: "none", wheelDelta: 1, x: 2, y: 0, screenX: 2, screenY: 0, width: 120, height: 10, shift: false, alt: false, ctrl: false,
    });
    expect(wheel2).toEqual({ handled: true, render: true });
    expect(navigator.highlightedId()).toBe(record2.id);

    // Wheel up moves highlight back to first subagent.
    const wheel3 = selector.handleMouse({
      type: "wheel", button: "none", wheelDelta: -1, x: 2, y: 0, screenX: 2, screenY: 0, width: 120, height: 10, shift: false, alt: false, ctrl: false,
    });
    expect(wheel3).toEqual({ handled: true, render: true });
    expect(navigator.highlightedId()).toBe(record1.id);
  });

  it("unfocuses the subagent list when clicking the editor", () => {
    const record = makeRecord("agent-11111111");
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeSource([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);

    // Focus the list via click.
    selector.handleMouse({
      type: "click", button: "left", x: 2, y: 1, screenX: 2, screenY: 1, width: 120, height: 10, shift: false, alt: false, ctrl: false,
    });
    expect(navigator.isListFocused()).toBe(true);

    // Click editor to release list focus.
    const editor = tui.children[tui.editorIndex].children[0];
    editor.handleMouse?.({
      type: "press", button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: 120, height: 3, shift: false, alt: false, ctrl: false,
    });
    expect(navigator.isListFocused()).toBe(false);
  });

  it("pages the list by clicking the hidden-row markers", () => {
    const records = Array.from({ length: 8 }, (_, index) => makeRecord(`agent-${index}1111111`));
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeSource(records));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    // One wheel event with magnitude 8 reuses pi-tui's native wheelDelta:
    // Main (index 0) jumps straight to the last agent (index 8).
    selector.handleMouse({
      type: "wheel", button: "none", wheelDelta: 8, x: 2, y: 0, screenX: 2, screenY: 0, width: 120, height: 10, shift: false, alt: false, ctrl: false,
    });
    expect(navigator.highlightedId()).toBe(records[7].id);
    expect(navigator.isListFocused()).toBe(true);

    // rows=40 shows 6 of 8 agents centered on the highlight:
    // Row 0 Command bar, Row 1 Main, Row 2 "↑ 2 hidden", Rows 3-8 agents[2..7].
    expect(selector.render(120).join("\n")).toContain("↑ 2 hidden");
    selector.handleMouse({
      type: "click", button: "left", x: 2, y: 2, screenX: 2, screenY: 2, width: 120, height: 10, shift: false, alt: false, ctrl: false,
    });
    expect(navigator.highlightedId()).toBe(records[1].id);
    expect(navigator.selectedId()).toBeNull();

    // Window now starts at 0: Rows 2-7 agents[0..5], Row 8 "↓ 2 hidden".
    expect(selector.render(120).join("\n")).toContain("↓ 2 hidden");
    selector.handleMouse({
      type: "click", button: "left", x: 2, y: 8, screenX: 2, screenY: 8, width: 120, height: 10, shift: false, alt: false, ctrl: false,
    });
    expect(navigator.highlightedId()).toBe(records[6].id);
    expect(navigator.selectedId()).toBeNull();
  });
});
