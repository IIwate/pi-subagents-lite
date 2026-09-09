/**
 * agent-navigator.lifecycle.test.ts — Lifecycle and refresh tests for AgentNavigator.
 *
 * Covers:
 *   - Refresh timer scheduling via simulated timer advances (no private timer assertion)
 *   - Clean teardown, TUI context detachment, and resource release on dispose
 *   - Reconnection across renderer switches and graceful error containment
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "../../../support/harness.js";
import { AgentNavigator } from "../../../../src/ui/agent-navigator.js";
import {
  makeRecord,
  makeManager,
  makeUI,
  mountSelector,
} from "../../../support/navigator.js";

describe("AgentNavigator — Lifecycle & Refresh", () => {
  let navigator: AgentNavigator | undefined;
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
    navigator = undefined;
    harness.onDispose(() => navigator?.dispose());
  });

  afterEach(async () => { await harness.dispose(); });

  it("clears the folded footer status when disposed", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]), undefined, undefined, undefined, false);
    navigator.setUICtx(ui.ctx as any);
    mountSelector(ui);

    expect(ui.statuses.has("subagents-lite")).toBe(true);

    navigator.dispose();
    expect(ui.statuses.has("subagents-lite")).toBe(false);
  });

  it("renders pushed context usage without reading session stats on timer ticks", () => {
    vi.useFakeTimers();
    const record = makeRecord();
    record.stats.lifetimeUsage.input = 100;
    record.stats.contextPercent = 23;
    record.execution.session.getSessionStats = vi.fn(() => {
      throw new Error("Session history must not be read during list rendering");
    });
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    const { tui, selector } = mountSelector(ui);
    tui.terminal.columns = 180;

    expect(selector.render(180).join("\n")).toContain("23%");
    record.stats.contextPercent = 47;
    vi.advanceTimersByTime(1000);
    expect(selector.render(180).join("\n")).toContain("47%");
    record.stats.contextPercent = null;
    vi.advanceTimersByTime(1000);
    expect(selector.render(180).join("\n")).not.toContain("47%");
    expect(record.execution.session.getSessionStats).not.toHaveBeenCalled();
  });

  it("keeps refresh active while any agent is unsettled even if status is not running or queued", () => {
    vi.useFakeTimers();
    const record = makeRecord("agent-unsettled", "error");
    record.execution.settled = false;
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    const { tui } = mountSelector(ui);

    tui.requestRender.mockClear();
    vi.advanceTimersByTime(1000);
    expect(tui.requestRender).toHaveBeenCalled();

    record.execution.settled = true;
    navigator.update();
    tui.requestRender.mockClear();
    vi.advanceTimersByTime(2000);
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("starts refresh timer in setUICtx when active agents are present and skips when absent", () => {
    vi.useFakeTimers();
    const activeRecord = makeRecord("agent-active", "running");
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([activeRecord]));
    navigator.setUICtx(ui.ctx as any);
    const { tui } = mountSelector(ui);

    tui.requestRender.mockClear();
    vi.advanceTimersByTime(1000);
    expect(tui.requestRender).toHaveBeenCalled();

    navigator.dispose();

    const completedRecord = makeRecord("agent-completed", "completed");
    completedRecord.execution.settled = true;
    const ui2 = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([completedRecord]));
    navigator.setUICtx(ui2.ctx as any);
    const { tui: tui2 } = mountSelector(ui2);

    tui2.requestRender.mockClear();
    vi.advanceTimersByTime(2000);
    expect(tui2.requestRender).not.toHaveBeenCalled();
  });

  it("keeps footer reconciliation active while a completed child is selected", () => {
    vi.useFakeTimers();
    const record = makeRecord("agent-completed", "completed");
    record.execution.settled = true;
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    const { tui } = mountSelector(ui);

    tui.requestRender.mockClear();
    vi.advanceTimersByTime(1000);
    expect(tui.requestRender).not.toHaveBeenCalled();

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    expect(navigator.selectedId()).toBe(record.id);

    tui.requestRender.mockClear();
    vi.advanceTimersByTime(1000);
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it("restores root components and unregisters widgets on dispose", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    mountSelector(ui);

    expect(ui.widgets.has("agent-navigator-selector")).toBe(true);
    navigator.dispose();
    expect(ui.widgets.has("agent-navigator-selector")).toBe(false);
  });

  it("finishes disposal when a stale host widget rejects removal", () => {
    vi.useFakeTimers();
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    const { tui } = mountSelector(ui);
    ui.ctx.setWidget.mockImplementation((_key: string, content: unknown) => {
      if (content === undefined) throw new Error("host widget unmount failed");
    });

    expect(() => navigator!.dispose()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    expect(tui.getClearOnShrink()).toBe(false);
    expect(ui.ctx.notify).toHaveBeenCalledWith(expect.stringContaining("host widget unmount failed"), "warning");
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
    vi.useFakeTimers();
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    const manager = makeManager([record]) as any;
    navigator = new AgentNavigator(manager);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);
    manager.listAgents = vi.fn(() => { throw new Error("selector state unavailable"); });

    expect(selector.render(120)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(selector.render(120)).toEqual([]);

    expect(ui.ctx.notify).toHaveBeenCalledTimes(1);
    expect(ui.ctx.notify).toHaveBeenCalledWith(
      expect.stringContaining("selector state unavailable"),
      "warning",
    );
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
});
