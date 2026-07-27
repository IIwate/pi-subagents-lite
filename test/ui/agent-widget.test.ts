/**
 * agent-widget.test.ts — Status-bar count badge tests.
 *
 * With the tree renderer removed, AgentWidget only owns the setStatus "N agents" badge.
 * These tests cover count text, clearing behavior, and polling timer lifecycle.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { AgentManager } from "../../src/agents/agent-manager.js";
import { AgentWidget } from "../../src/ui/agent-widget.js";

function makeMockManager(agents: any[]): AgentManager {
  return { listAgents: () => agents } as unknown as AgentManager;
}

function makeAgent(id: string, status: string): any {
  return {
    id,
    lifecycle: { status, startedAt: Date.now() },
    stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 } },
  };
}

describe("status bar format", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a plural count without cost for multiple running agents", () => {
    const uiCtx = { setStatus: vi.fn() };
    const manager = makeMockManager([]);
    const widget = new AgentWidget(manager);
    widget.setUICtx(uiCtx);

    (manager as any).listAgents = () => [makeAgent("a1", "running"), makeAgent("a2", "queued")];
    widget.update();

    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", "2 agents");
    const text = uiCtx.setStatus.mock.calls.find(c => c[0] === "subagents")?.[1] as string;
    expect(text).not.toContain("$");
  });

  it("shows a singular count for one running agent", () => {
    const uiCtx = { setStatus: vi.fn() };
    const manager = makeMockManager([makeAgent("a1", "running")]);
    const widget = new AgentWidget(manager);
    widget.setUICtx(uiCtx);
    widget.update();

    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", "1 agent");
  });

  it("clears the badge when only finished agents remain", () => {
    const uiCtx = { setStatus: vi.fn() };
    const manager = makeMockManager([]);
    const widget = new AgentWidget(manager);
    widget.setUICtx(uiCtx);

    // Show a running badge first so the clearing action is observable.
    (manager as any).listAgents = () => [makeAgent("r1", "running")];
    widget.update();
    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", "1 agent");

    (manager as any).listAgents = () => [makeAgent("f1", "completed")];
    widget.update();
    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", undefined);
  });

  it("does not call setStatus again when text is unchanged", () => {
    const uiCtx = { setStatus: vi.fn() };
    const manager = makeMockManager([makeAgent("a1", "running")]);
    const widget = new AgentWidget(manager);
    widget.setUICtx(uiCtx);

    widget.update();
    widget.update();
    widget.update();

    const calls = uiCtx.setStatus.mock.calls.filter(c => c[0] === "subagents");
    expect(calls).toHaveLength(1);
  });

  it("stops polling at zero and lets ensureTimer restart it", () => {
    vi.useFakeTimers();
    const uiCtx = { setStatus: vi.fn() };
    let agents = [makeAgent("a1", "running")];
    const manager = makeMockManager([]);
    (manager as any).listAgents = () => agents;
    const widget = new AgentWidget(manager);
    widget.setUICtx(uiCtx);
    widget.ensureTimer();

    expect(vi.getTimerCount()).toBe(1);

    // After all agents finish, the next poll stops the timer.
    agents = [makeAgent("a1", "completed")];
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(0);
    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", undefined);

    // A new agent lets ensureTimer restart polling.
    agents = [makeAgent("a2", "running")];
    widget.ensureTimer();
    expect(vi.getTimerCount()).toBe(1);
    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", "1 agent");

    widget.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops polling after a status failure and warns once", () => {
    vi.useFakeTimers();
    const uiCtx = { setStatus: vi.fn(), notify: vi.fn() };
    const manager = makeMockManager([]) as any;
    manager.listAgents = vi.fn(() => { throw new Error("status backend unavailable"); });
    const widget = new AgentWidget(manager);
    widget.setUICtx(uiCtx);

    expect(() => widget.ensureTimer()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => vi.advanceTimersByTime(3000)).not.toThrow();

    expect(uiCtx.notify).toHaveBeenCalledTimes(1);
    expect(uiCtx.notify).toHaveBeenCalledWith(
      expect.stringContaining("status backend unavailable"),
      "warning",
    );
    widget.dispose();
  });

  it("dispose clears the badge and timer", () => {
    const uiCtx = { setStatus: vi.fn() };
    const manager = makeMockManager([makeAgent("a1", "running")]);
    const widget = new AgentWidget(manager);
    widget.setUICtx(uiCtx);
    widget.update();

    widget.dispose();
    expect(uiCtx.setStatus).toHaveBeenLastCalledWith("subagents", undefined);
  });

  it("finishes disposal when the host rejects status clearing", () => {
    vi.useFakeTimers();
    const uiCtx = { setStatus: vi.fn(), notify: vi.fn() };
    const manager = makeMockManager([makeAgent("a1", "running")]);
    const widget = new AgentWidget(manager);
    widget.setUICtx(uiCtx);
    widget.ensureTimer();
    uiCtx.setStatus.mockImplementation(() => { throw new Error("status host disposed"); });

    expect(() => widget.dispose()).not.toThrow();

    expect(vi.getTimerCount()).toBe(0);
    expect(uiCtx.notify).toHaveBeenCalledWith(
      expect.stringContaining("status host disposed"),
      "warning",
    );
  });
});
