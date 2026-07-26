/**
 * agent-widget.test.ts — 状态栏计数徽标测试。
 *
 * 树状渲染已移除，AgentWidget 只负责 setStatus 的 "N agents" 徽标：
 * 覆盖计数文本、清除时机与轮询定时器的启停。
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

  it("多个运行中代理显示复数计数且不含成本", () => {
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

  it("单个运行中代理显示单数计数", () => {
    const uiCtx = { setStatus: vi.fn() };
    const manager = makeMockManager([makeAgent("a1", "running")]);
    const widget = new AgentWidget(manager);
    widget.setUICtx(uiCtx);
    widget.update();

    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", "1 agent");
  });

  it("仅剩已完成代理时清除徽标", () => {
    const uiCtx = { setStatus: vi.fn() };
    const manager = makeMockManager([]);
    const widget = new AgentWidget(manager);
    widget.setUICtx(uiCtx);

    // 先出现运行中徽标，才能观察到清除动作
    (manager as any).listAgents = () => [makeAgent("r1", "running")];
    widget.update();
    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", "1 agent");

    (manager as any).listAgents = () => [makeAgent("f1", "completed")];
    widget.update();
    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", undefined);
  });

  it("文本未变化时不重复调用 setStatus", () => {
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

  it("计数归零时停止轮询定时器，ensureTimer 可重启", () => {
    vi.useFakeTimers();
    const uiCtx = { setStatus: vi.fn() };
    let agents = [makeAgent("a1", "running")];
    const manager = makeMockManager([]);
    (manager as any).listAgents = () => agents;
    const widget = new AgentWidget(manager);
    widget.setUICtx(uiCtx);
    widget.ensureTimer();

    expect(vi.getTimerCount()).toBe(1);

    // 代理全部结束 → 下一次轮询后定时器停止
    agents = [makeAgent("a1", "completed")];
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(0);
    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", undefined);

    // 新代理出现 → ensureTimer 重启轮询
    agents = [makeAgent("a2", "running")];
    widget.ensureTimer();
    expect(vi.getTimerCount()).toBe(1);
    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", "1 agent");

    widget.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dispose 清除徽标与定时器", () => {
    const uiCtx = { setStatus: vi.fn() };
    const manager = makeMockManager([makeAgent("a1", "running")]);
    const widget = new AgentWidget(manager);
    widget.setUICtx(uiCtx);
    widget.update();

    widget.dispose();
    expect(uiCtx.setStatus).toHaveBeenLastCalledWith("subagents", undefined);
  });
});
