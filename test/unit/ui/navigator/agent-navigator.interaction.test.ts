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
import { createTestHarness, type TestHarness } from "../../../support/harness.js";
import { AgentNavigator } from "../../../../src/ui/agent-navigator.js";
import * as shell from "../../../../src/shell.js";
import type { SpawnCoordinator } from "../../../../src/spawn/spawn-coordinator.js";
import {
  makeRecord,
  makeManager,
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
    vi.spyOn(shell, "getCoordinator").mockReturnValue({
      getDeliverableMessages: () => [{ role: "assistant", content: "Available result" }],
    } as unknown as SpawnCoordinator);
    navigator = new AgentNavigator(makeManager([record]));
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
    ui.baseEditor.onSubmit?.("continue the child");

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

    ui.baseEditor.onSubmit?.("/agents");
    expect(parentSubmit).toHaveBeenCalledWith("/agents");
  });

  it("stops a running subagent when Escape is pressed in the editor while viewing it", () => {
    const record = makeRecord();
    record.lifecycle.status = "running";
    const manager = makeManager([record]);
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
    const manager = makeManager([record]);
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
    const manager = makeManager([record]);
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
    const manager = makeManager([record]);
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
    navigator = new AgentNavigator(makeManager([record]), routeInput);
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
    navigator = new AgentNavigator(makeManager([record]), routeInput);
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
    navigator = new AgentNavigator(makeManager([record]), vi.fn(() => pending));
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
    const manager = makeManager([record]);
    const queued = "queued\x07 steer\x1b]0;source-title\x07 1\r\nnext line";
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
    const manager = makeManager([record]);
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

    expect(manager.dequeueMessages).toHaveBeenCalledWith(record.id);
    expect(parentDequeue).not.toHaveBeenCalled();
    expect(ui.ctx.notify).toHaveBeenCalledWith("No queued messages to restore", "info");
  });

  it("falls through to parent dequeue handler when no subagent is selected", () => {
    const record = makeRecord();
    const manager = makeManager([record]);
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
});
