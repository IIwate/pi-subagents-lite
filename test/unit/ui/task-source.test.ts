import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTask, reduceTask } from "../../../src/domain/task.js";
import type { TaskEngine } from "../../../src/engine/task-engine.js";
import { TaskNavigationSource } from "../../../src/ui/task-source.js";
import { createTestHarness, type TestHarness } from "../../support/harness.js";

describe("Task navigation retention", () => {
  let resources: TestHarness;
  beforeEach(() => { resources = createTestHarness(); vi.useFakeTimers(); });
  afterEach(() => resources.dispose());

  function createSource(completedAt: number, listed = true) {
    const task = reduceTask(createTask("task", "operation", { agent: "worker", model: { provider: "test", id: "model" },
      thinkingLevel: "off", tools: [], cwd: "/project", systemPrompt: "", limits: { graceTurns: 1 } }),
    { type: "settled", operationId: "operation", outcome: { status: "completed", result: "Durable result" } });
    const state = { task, execution: { messages: [], queued: [], lastResult: { operationId: "operation", completedAt, startedAt: completedAt },
      stats: { input: 0, output: 0, cost: 0, toolUses: 0, turnCount: 1, compactions: 0, contextPercent: null } } };
    const engine = {
      subscribe: () => () => {}, observe: async () => () => {}, list: vi.fn(() => listed ? [state.task] : []), get: () => state.task,
      binding: () => ({ display: { name: "Worker", description: "Read a result" } }), close: vi.fn(),
      snapshot: async () => state,
    };
    const source = new TaskNavigationSource(engine as unknown as TaskEngine);
    resources.onDispose(() => source.dispose());
    return { source, engine, state };
  }

  it.each([true, false])("keeps expired tasks hidden at first publication with initially listed = %s", async listed => {
    const { source, engine, state } = createSource(Date.now() - 7_200_000, listed);
    const visible: string[][] = [];
    resources.onDispose(source.subscribe(() => { visible.push(source.listAgents().map(agent => agent.id)); }));
    await source.refresh();
    if (!listed) {
      engine.list.mockReturnValue([state.task]);
      await source.refresh();
    }
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every(ids => ids.length === 0)).toBe(true);
    expect(source.getRecord("task")).toBeUndefined();
    expect(engine.get().state).toMatchObject({ outcome: { result: "Durable result" } });
    expect(engine.close).not.toHaveBeenCalled();
  });

  it.each(["list", "record"])("expires a settled task on a %s read before the timer runs", async read => {
    const completedAt = Date.now();
    const { source } = createSource(completedAt);
    await source.refresh();
    vi.setSystemTime(completedAt + 599_999);
    expect(source.listAgents()).toHaveLength(1);
    const changed = vi.fn();
    resources.onDispose(source.subscribe(changed));
    vi.setSystemTime(completedAt + 600_000);
    if (read === "list") expect(source.listAgents()).toEqual([]);
    else expect(source.getRecord("task")).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("shows a new operation after the previous operation's display window expired", async () => {
    const { source, state } = createSource(Date.now() - 7_200_000);
    await source.refresh();
    expect(source.listAgents()).toEqual([]);
    state.task = reduceTask(createTask("task", "next", state.task.policy),
      { type: "settled", operationId: "next", outcome: { status: "completed", result: "Fresh result" } });
    state.execution.lastResult = { operationId: "next", completedAt: Date.now(), startedAt: Date.now() };
    await source.refresh();
    expect(source.getRecord("task")).toMatchObject({ operationId: "next", result: "Fresh result" });
  });

  it("pauses the remaining display window while pinned and keeps the execution owner intact", async () => {
    const { source, engine } = createSource(Date.now());
    await source.refresh();
    await vi.advanceTimersByTimeAsync(240_000);
    await source.dispatch({ type: "pin", taskId: "task", operationId: "operation" });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(source.listAgents()).toHaveLength(1);
    await source.dispatch({ type: "pin", taskId: "task", operationId: "operation" });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(source.listAgents()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(source.listAgents()).toEqual([]);
    expect(engine.get().state).toMatchObject({ outcome: { result: "Durable result" } });
    expect(engine.close).not.toHaveBeenCalled();
  });
});
