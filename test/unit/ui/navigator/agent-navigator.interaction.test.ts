/**
 * agent-navigator.interaction.test.ts — Child agent interaction tests for AgentNavigator.
 *
 * Covers:
 *   - Child session message forwarding & command routing
 *   - Escape cancellation of active child execution
 *   - Concurrency blocked / failed interaction notices
 *   - Stale interaction resolution across newer interactions and screen switches
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { createTestHarness, type TestHarness } from "../../../support/harness.js";
import { AgentNavigator } from "../../../../src/ui/agent-navigator.js";
import type { NavigationAction, NavigationReply } from "../../../../src/ui/navigation.js";
import {
  makeRecord,
  makeSource,
  makeUI,
  makeTui,
  mountSelector,
} from "../../../support/navigator.js";

describe("AgentNavigator — Interaction", () => {
  let navigator: AgentNavigator | undefined;
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
    navigator = undefined;
    harness.onDispose(() => navigator?.dispose());
  });

  afterEach(async () => { await harness.dispose(); });

  it("prevents re-entrant opening when delivery selector is already active", async () => {
    const record = makeRecord();
    record.lifecycle.takenOver = true;
    const ui = makeUI({ value: "" });
    const gate = Promise.withResolvers<boolean>();
    const custom = vi.fn(() => gate.promise);
    navigator = new AgentNavigator(makeSource([record]));
    navigator.setUICtx({ ...ui.ctx, custom } as any);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    expect(navigator.highlightedId()).toBe(record.id);

    const firstOpen = navigator.openDeliverySelector();
    try {
      await navigator.openDeliverySelector();
      expect(custom).toHaveBeenCalledOnce();
    } finally {
      gate.resolve(false);
      await firstOpen;
    }
  });

  it("decorates the editor and forwards printable input after leaving the list", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeSource([record]));
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
    navigator = new AgentNavigator(makeSource([record]), routeInput);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    const editor = ui.editorFactory(makeTui(), {}, {});
    const parentSubmit = vi.fn();
    editor.onSubmit = parentSubmit;
    ui.baseEditor.onSubmit?.("continue the child");

    expect(routeInput).toHaveBeenCalledWith({ type: "steer", taskId: record.id, operationId: record.id, input: { text: "continue the child" } });
    expect(ui.baseEditor.addToHistory).toHaveBeenCalledWith("continue the child");
    expect(parentSubmit).not.toHaveBeenCalled();

    const parentFollowUp = vi.fn();
    editor.actionHandlers.set("app.message.followUp", parentFollowUp);
    ui.baseEditor.setText("follow up the child");
    ui.baseEditor.actionHandlers.get("app.message.followUp")?.();
    expect(routeInput).toHaveBeenCalledWith({ type: "followUp", taskId: record.id, operationId: record.id, input: { text: "follow up the child" } });
    expect(parentFollowUp).not.toHaveBeenCalled();
    expect(ui.baseEditor.getText()).toBe("");

    ui.baseEditor.onSubmit?.("/agents");
    expect(parentSubmit).not.toHaveBeenCalled();
    expect(routeInput).toHaveBeenCalledTimes(2);
    ui.baseEditor.onSubmit?.("/main");
    expect(navigator.selectedId()).toBeNull();
    ui.baseEditor.onSubmit?.("/agents");
    expect(parentSubmit).toHaveBeenCalledWith("/agents");
  });

  it("shows local command responses without changing the child conversation or queue", () => {
    const record = makeRecord();
    const queued = "Review\x07 the diff\x1b]0;unsafe-title\x07\nKeep the summary short";
    record.execution.session.getSteeringMessages = () => [queued];
    const source = makeSource([record]);
    const messages = source.transcript(record.id).messages;
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(source);
    navigator.setUICtx(ui.ctx as any);
    const { tui } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    navigator.handleEditorSubmit("/help");
    expect(tui.document.children[tui.chatIndex].render(120).join("\n")).toContain("/status - Inspect the active subagent");
    navigator.handleEditorSubmit("/status");
    const status = tui.document.children[tui.chatIndex].render(120).join("\n");
    expect(status).toContain(record.id);
    expect(status).toContain("openai-test/gpt-test");
    expect(status).toContain("Control: Autonomous");
    navigator.handleEditorSubmit("/queue");
    const queue = tui.document.children[tui.chatIndex].render(120).join("\n");
    expect(queue).toContain("Keep the summary short");
    expect(queue).not.toContain("\x07");
    expect(queue).not.toContain("unsafe-title");
    expect(tui.document.children[tui.chatIndex].render(24).every((line: string) => visibleWidth(line) <= 24)).toBe(true);
    expect(source.sendInput).not.toHaveBeenCalled();
    expect(source.dequeueMessages).not.toHaveBeenCalled();
    expect(source.transcript(record.id).messages).toEqual(messages);
    expect(source.getRecord(record.id).queued[0].input.text).toBe(queued);

    navigator.handleEditorSubmit("Inspect another file");
    expect(tui.document.children[tui.chatIndex].render(120).join("\n")).not.toContain("/queue");
    expect(source.sendInput).toHaveBeenCalledWith(record.id, "Inspect another file", undefined, "steer");
  });

  it("rejects unsupported commands, shell input, and extra arguments before parent submission", () => {
    const record = makeRecord();
    const source = makeSource([record]);
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(source);
    navigator.setUICtx(ui.ctx as any);
    const { tui } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    const editor = tui.children[tui.editorIndex].children[0];
    const parentSubmit = vi.fn();
    const parentFollowUp = vi.fn();
    editor.onSubmit = parentSubmit;
    editor.actionHandlers.set("app.message.followUp", parentFollowUp);

    ui.baseEditor.onSubmit?.("/model another-model");
    expect(tui.document.children[tui.chatIndex].render(120).join("\n")).toContain("Unknown subagent command");
    ui.baseEditor.onSubmit?.("/stop\nextra input");
    expect(tui.document.children[tui.chatIndex].render(120).join("\n")).toContain("Usage: /stop");
    ui.baseEditor.setText("! echo unintended");
    ui.baseEditor.actionHandlers.get("app.message.followUp")?.();
    expect(tui.document.children[tui.chatIndex].render(120).join("\n")).toContain("Shell commands are unavailable");
    expect(parentSubmit).not.toHaveBeenCalled();
    expect(parentFollowUp).not.toHaveBeenCalled();
    expect(source.sendInput).not.toHaveBeenCalled();
    expect(source.abort).not.toHaveBeenCalled();
    expect(source.takeOver).not.toHaveBeenCalled();
    expect(ui.ctx.notify).not.toHaveBeenCalled();
  });

  it("targets the active subagent for commands and explicit message selection", async () => {
    const active = makeRecord("agent-active");
    const candidate = makeRecord("agent-candidate");
    const source = makeSource([active, candidate]);
    const dispatch = vi.fn((action: NavigationAction): NavigationReply | Promise<NavigationReply> => source.dispatch(action));
    const ui = makeUI({ value: "" });
    const selection = Promise.withResolvers<boolean>();
    harness.onDispose(() => { selection.resolve(false); });
    let selector: { handleInput(data: string): void } | undefined;
    const custom = vi.fn((factory: any) => {
      selector = factory(tui, ui.theme, {}, selection.resolve);
      return selection.promise;
    });
    navigator = new AgentNavigator(source, dispatch);
    navigator.setUICtx({ ...ui.ctx, custom } as any);
    const { tui } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    navigator.handleTerminalInput("\x1b[B");
    expect(navigator.highlightedId()).toBe(candidate.id);
    expect(navigator.selectedId()).toBe(active.id);

    navigator.handleEditorSubmit("/stop");
    expect(source.abort).toHaveBeenCalledWith(active.id, "user");
    navigator.handleEditorSubmit("/deliver");
    expect(custom).not.toHaveBeenCalled();
    navigator.handleEditorSubmit("/takeover");
    expect(source.takeOver).toHaveBeenCalledWith(active.id);
    navigator.handleEditorSubmit("/deliver");
    expect(custom).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls.some(([action]) => action.type === "deliver")).toBe(false);
    selector!.handleInput("\r");
    await selection.promise;
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "deliver", selection: expect.objectContaining({ taskId: active.id, operationId: active.id }),
    }));
    expect(candidate.lifecycle.takenOver).toBeUndefined();
  });

  it("keeps newer command output when an older action fails", async () => {
    const record = makeRecord();
    const pending = Promise.withResolvers<NavigationReply>();
    harness.onDispose(() => { pending.resolve({ accepted: false, reason: "unavailable" }); });
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeSource([record]), () => pending.promise);
    navigator.setUICtx(ui.ctx as any);
    const { tui } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    navigator.handleEditorSubmit("/stop");
    navigator.handleEditorSubmit("/status");
    pending.resolve({ accepted: false, reason: "unavailable", message: "Delayed stop failure" });
    await pending.promise;
    const output = tui.document.children[tui.chatIndex].render(120).join("\n");
    expect(output).toContain("/status");
    expect(output).not.toContain("Delayed stop failure");
  });

  it("uses child command completion and restores the parent provider on Main", async () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    const install = vi.fn();
    Object.assign(ui.baseEditor, { setAutocompleteProvider: install });
    navigator = new AgentNavigator(makeSource([record]));
    navigator.setUICtx(ui.ctx as any);
    const { tui } = mountSelector(ui);
    const editor = tui.children[tui.editorIndex].children[0];
    const parentSuggestions = { items: [{ value: "agents", label: "agents" }], prefix: "/a" };
    const parent = {
      getSuggestions: vi.fn(async () => parentSuggestions),
      applyCompletion: vi.fn(),
      shouldTriggerFileCompletion: vi.fn(() => true),
    };
    editor.setAutocompleteProvider(parent);
    const provider = install.mock.lastCall![0] as AutocompleteProvider;
    const options = { signal: new AbortController().signal, force: true };
    expect(await provider.getSuggestions(["/a"], 0, 2, options)).toBe(parentSuggestions);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    parent.getSuggestions.mockClear();

    const suggestions = await provider.getSuggestions(["/sta"], 0, 4, options);
    expect(suggestions?.items.map(item => item.value)).toEqual(["status"]);
    expect(provider.applyCompletion(["/sta"], 0, 4, suggestions!.items[0], suggestions!.prefix).lines).toEqual(["/status "]);
    expect(provider.shouldTriggerFileCompletion?.(["/sta"], 0, 4)).toBe(false);
    expect(await provider.getSuggestions(["/status @file"], 0, 13, options)).toBeNull();
    expect(parent.getSuggestions).not.toHaveBeenCalled();
    expect(parent.applyCompletion).not.toHaveBeenCalled();
    navigator.handleEditorSubmit("/main");
    expect(await provider.getSuggestions(["/a"], 0, 2, options)).toBe(parentSuggestions);
    expect(provider.shouldTriggerFileCompletion?.(["/a"], 0, 2)).toBe(true);

    const delayed = Promise.withResolvers<typeof parentSuggestions>();
    harness.onDispose(() => { delayed.resolve(parentSuggestions); });
    parent.getSuggestions.mockImplementationOnce(() => delayed.promise);
    const completion = provider.getSuggestions(["/a"], 0, 2, options);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    delayed.resolve(parentSuggestions);
    expect(await completion).toBeNull();
  });

  it("consumes input when the active task disappears before submission", () => {
    const records = [makeRecord()];
    const source = makeSource(records);
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(source);
    navigator.setUICtx(ui.ctx as any);
    const { tui } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    const editor = tui.children[tui.editorIndex].children[0];
    const parentSubmit = vi.fn();
    editor.onSubmit = parentSubmit;
    records.length = 0;

    ui.baseEditor.onSubmit?.("/stop");
    expect(parentSubmit).not.toHaveBeenCalled();
    expect(source.abort).not.toHaveBeenCalled();
    expect(navigator.selectedId()).toBeNull();
    expect(ui.ctx.notify).toHaveBeenCalledWith("The selected subagent is unavailable. Input was not sent.", "warning");
  });

  it("stops a running subagent when Escape is pressed in the editor while viewing it", () => {
    const record = makeRecord();
    record.lifecycle.status = "running";
    const manager = makeSource([record]);
    manager.abort = vi.fn().mockReturnValue(true);
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(manager);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    expect(navigator.selectedId()).toBe(record.id);

    const editor = ui.editorFactory(makeTui(), {}, {});
    const parentEscape = vi.fn();
    editor.onEscape = parentEscape;

    ui.baseEditor.onEscape?.();

    expect(manager.abort).toHaveBeenCalledWith(record.id, "user");
    expect(parentEscape).not.toHaveBeenCalled();

    // When the agent is no longer running, Escape falls through to parentEscape:
    record.lifecycle.status = "stopped";
    ui.baseEditor.onEscape?.();
    expect(parentEscape).toHaveBeenCalledOnce();
  });

  it("stops a running subagent when Escape is pressed while viewing it with list focused", () => {
    const record = makeRecord();
    record.lifecycle.status = "running";
    const manager = makeSource([record]);
    manager.abort = vi.fn().mockReturnValue(true);
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(manager);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    expect(navigator.selectedId()).toBe(record.id);
    expect(navigator.isListFocused()).toBe(true);

    const res = navigator.handleTerminalInput("\x1b");
    expect(res?.consume).toBe(true);
    expect(manager.abort).toHaveBeenCalledWith(record.id, "user");
  });

  it("cancels subagent retry backoff on Escape in editor without stopping the subagent", () => {
    const record = makeRecord();
    record.lifecycle.status = "running";
    record.execution.retryState = {
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      startAt: Date.now(),
    };
    const manager = makeSource([record]);
    manager.abortRetry = vi.fn().mockReturnValue(true);
    manager.abort = vi.fn().mockReturnValue(true);
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(manager);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    expect(navigator.selectedId()).toBe(record.id);

    const editor = ui.editorFactory(makeTui(), {}, {});
    const parentEscape = vi.fn();
    editor.onEscape = parentEscape;

    ui.baseEditor.onEscape?.();

    expect(manager.abortRetry).toHaveBeenCalledWith(record.id);
    expect(manager.abort).not.toHaveBeenCalled();
    expect(parentEscape).not.toHaveBeenCalled();
  });

  it("cancels subagent retry backoff on Escape with list focused without stopping the subagent", () => {
    const record = makeRecord();
    record.lifecycle.status = "running";
    record.execution.retryState = {
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      startAt: Date.now(),
    };
    const manager = makeSource([record]);
    manager.abortRetry = vi.fn().mockReturnValue(true);
    manager.abort = vi.fn().mockReturnValue(true);
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(manager);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    expect(navigator.selectedId()).toBe(record.id);
    expect(navigator.isListFocused()).toBe(true);

    const res = navigator.handleTerminalInput("\x1b");
    expect(res?.consume).toBe(true);
    expect(manager.abortRetry).toHaveBeenCalledWith(record.id);
    expect(manager.abort).not.toHaveBeenCalled();
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
    navigator = new AgentNavigator(makeSource([record]), routeInput);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    const editor = ui.editorFactory(makeTui(), {}, {});
    editor.onSubmit = vi.fn();

    ui.baseEditor.onSubmit?.("continue the child");
    await vi.waitFor(() => {
      expect(selector.render(120).join("\n")).toContain(
        "Blocked: cliproxyapi/gpt-5.6-sol concurrency limit reached",
      );
    });
    expect(ui.ctx.setEditorText).toHaveBeenCalledWith("continue the child");

    ui.baseEditor.onSubmit?.("retry");
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
    navigator = new AgentNavigator(makeSource([record]), routeInput);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    navigator.toggleList();
    const editor = ui.editorFactory(makeTui(), {}, {});
    editor.onSubmit = vi.fn();

    ui.baseEditor.onSubmit?.("continue the child");
    await vi.waitFor(() => {
      expect(ui.statuses.get("subagents-lite")).toContain(
        "Blocked: cliproxyapi/gpt-5.6-sol concurrency limit reached",
      );
    });
    expect(selector.render(120)).toEqual([]);

    ui.baseEditor.onSubmit?.("retry");
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
    navigator = new AgentNavigator(makeSource([record]), routeInput);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    const editor = ui.editorFactory(makeTui(), {}, {});
    editor.onSubmit = vi.fn();

    ui.baseEditor.onSubmit?.("first");
    ui.baseEditor.onSubmit?.("second");
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
    navigator = new AgentNavigator(makeSource([record]), vi.fn(() => pending));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    const editor = ui.editorFactory(makeTui(), {}, {});
    editor.onSubmit = vi.fn();
    ui.baseEditor.onSubmit?.("continue");

    navigator.handleTerminalInput("\x1b[A");
    navigator.handleTerminalInput("\r");
    ui.baseEditor.setText("main draft");
    resolveInteraction({ accepted: false, reason: "concurrency", modelKey: "test/model" });
    await Promise.resolve();

    expect(selector.render(120).join("\n")).not.toContain("Blocked:");
    expect(ui.baseEditor.getText()).toBe("main draft");
  });

  it("restores queued steering messages back into the editor on Alt+Up (dequeue)", () => {
    const record = makeRecord();
    const manager = makeSource([record]);
    const queued = "queued\x07 steer\x1b]0;source-title\x07 1\r\nnext line";
    record.execution.session.getSteeringMessages = () => [queued, "queued steer 2"];
    manager.dequeueMessages = vi.fn().mockReturnValue([queued, "queued steer 2"]);
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(manager);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    expect(navigator.selectedId()).toBe(record.id);

    ui.baseEditor.setText("existing draft");
    const parentDequeue = vi.fn();
    ui.baseEditor.actionHandlers.set("app.message.dequeue", parentDequeue);
    const editor = ui.editorFactory(makeTui(), {}, {});

    // Trigger wrapped action
    const dequeueHandler = editor.actionHandlers?.get("app.message.dequeue");
    expect(dequeueHandler).toBeDefined();
    dequeueHandler?.();

    expect(manager.dequeueMessages).toHaveBeenCalledWith(record.id);
    expect(parentDequeue).not.toHaveBeenCalled();
    expect(ui.baseEditor.getText()).toBe(`${queued}\n\nqueued steer 2\n\nexisting draft`);
    expect(ui.ctx.notify).toHaveBeenCalledWith("Restored 2 queued messages to editor", "info");
  });

  it("notifies when no queued messages exist to restore on Alt+Up", () => {
    const record = makeRecord();
    const manager = makeSource([record]);
    manager.dequeueMessages = vi.fn().mockReturnValue([]);
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(manager);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    expect(navigator.selectedId()).toBe(record.id);

    const parentDequeue = vi.fn();
    ui.baseEditor.actionHandlers.set("app.message.dequeue", parentDequeue);
    const editor = ui.editorFactory(makeTui(), {}, {});

    const dequeueHandler = editor.actionHandlers?.get("app.message.dequeue");
    dequeueHandler?.();

    expect(manager.dequeueMessages).not.toHaveBeenCalled();
    expect(parentDequeue).not.toHaveBeenCalled();
    expect(ui.ctx.notify).toHaveBeenCalledWith("No queued messages to restore", "info");
  });

  it("falls through to parent dequeue handler when no subagent is selected", () => {
    const record = makeRecord();
    const manager = makeSource([record]);
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(manager);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);

    const parentDequeue = vi.fn();
    ui.baseEditor.actionHandlers.set("app.message.dequeue", parentDequeue);
    const editor = ui.editorFactory(makeTui(), {}, {});

    expect(navigator.selectedId()).toBeNull();
    const dequeueHandler = editor.actionHandlers?.get("app.message.dequeue");
    dequeueHandler?.();

    expect(parentDequeue).toHaveBeenCalledOnce();
  });

  it("freezes list order while inside a child screen and applies global re-sorting only upon returning to Main", () => {
    const recordA = makeRecord("agent-aaaa", "running");
    const recordB = makeRecord("agent-bbbb", "running");
    const recordC = makeRecord("agent-cccc", "running");
    recordA.display.name = "agent-aaaa";
    recordB.display.name = "agent-bbbb";
    recordC.display.name = "agent-cccc";
    recordA.lifecycle.startedAt = 1000;
    recordB.lifecycle.startedAt = 2000;
    recordC.lifecycle.startedAt = 3000;

    const allRecords = [recordA, recordB, recordC];
    const source = makeSource(allRecords);
    source.listAgents = () => {
      return [...allRecords].sort((a, b) => {
        const rank = (s: string) => (s === "aborted" ? 0 : 1);
        return rank(a.lifecycle.status) - rank(b.lifecycle.status) || a.lifecycle.startedAt - b.lifecycle.startedAt;
      }).map(r => source.getRecord(r.id));
    };
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(source);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    // In Main: initial order is A, B, C (all running, sorted by startedAt)
    let lines = selector.render(120);
    expect(lines.join("\n")).toMatch(/Main[\s\S]*agent-aaaa[\s\S]*agent-bbbb[\s\S]*agent-cccc/);

    // Enter child screen for agent B
    navigator.handleTerminalInput("\x1b[B"); // focus Main
    navigator.handleTerminalInput("\x1b[B"); // highlight A
    navigator.handleTerminalInput("\x1b[B"); // highlight B
    navigator.handleTerminalInput("\r");     // activate B
    expect(navigator.selectedId()).toBe("agent-bbbb");

    // Manually stop agent B (status becomes aborted, which normally ranks highest at 0)
    recordB.lifecycle.status = "aborted";
    navigator.update();

    // Order must remain FROZEN (A, B, C) while viewing child screen; B must not jump to index 0
    lines = selector.render(120);
    expect(lines.join("\n")).toMatch(/agent-aaaa[\s\S]*agent-bbbb[\s\S]*agent-cccc/);
    expect(lines.join("\n")).toContain("agent-bbbb (Aborted)");

    // Even if a new agent D is spawned in the background, it appends to the end
    const recordD = makeRecord("agent-dddd", "running");
    recordD.display.name = "agent-dddd";
    recordD.lifecycle.startedAt = 500; // earlier startedAt, but should not displace existing
    allRecords.push(recordD);
    navigator.update();

    lines = selector.render(120);
    expect(lines.join("\n")).toMatch(/agent-aaaa[\s\S]*agent-bbbb[\s\S]*agent-cccc[\s\S]*agent-dddd/);

    // Return to Main: order unfreezes and re-sorts by rank (aborted B moves to top!)
    navigator.activateMain();
    expect(navigator.selectedId()).toBeNull();

    lines = selector.render(120);
    // B (aborted, rank 0) is now at the top of subagents, followed by running agents
    expect(lines.join("\n")).toMatch(/Main[\s\S]*agent-bbbb[\s\S]*agent-dddd[\s\S]*agent-aaaa[\s\S]*agent-cccc/);
  });
});
