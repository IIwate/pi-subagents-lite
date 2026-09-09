/**
 * agent-navigator.input.test.ts — Keyboard input and focus tests for AgentNavigator.
 *
 * Covers:
 *   - Focus movement (arrows, Enter, Esc, Ctrl+C)
 *   - Continuous navigation across subagent and Main views
 *   - Paste handling & focus release
 *   - Highlight state tracking via public highlightedId() API
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { createTestHarness, type TestHarness } from "../../../support/harness.js";
import { AgentNavigator } from "../../../../src/ui/agent-navigator.js";
import {
  makeRecord,
  makeManager,
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
    navigator = new AgentNavigator(makeManager([makeRecord()]));
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
    navigator = new AgentNavigator(makeManager([record]));
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
    navigator = new AgentNavigator(makeManager([record]));
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
    navigator = new AgentNavigator(makeManager([record]));
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
    navigator = new AgentNavigator(makeManager([record]));
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
    navigator = new AgentNavigator(makeManager([record]));
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
    navigator = new AgentNavigator(makeManager([record]), routeInput);
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
    expect(routeInput).toHaveBeenCalledWith("agent-1", "Fix this bug");
    expect(parentSubmit).not.toHaveBeenCalled();
  });

  it("switches to Main on Enter from subagent view without sending message", () => {
    const record = makeRecord("agent-1");
    const ui = makeUI({ value: "" });
    const routeInput = vi.fn().mockResolvedValue({ accepted: true });
    navigator = new AgentNavigator(makeManager([record]), routeInput);
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
    navigator = new AgentNavigator(makeManager([record1, record2]), routeInput);
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
    navigator = new AgentNavigator(makeManager([record1, record2]));
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
    navigator = new AgentNavigator(makeManager([record]));
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
});
