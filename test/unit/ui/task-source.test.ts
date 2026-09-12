import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTask, reduceTask } from "../../../src/domain/task.js";
import type { TaskEngine } from "../../../src/engine/task-engine.js";
import { TaskNavigationSource } from "../../../src/ui/task-source.js";
import { createTestHarness, type TestHarness } from "../../support/harness.js";

describe("Task navigation retention", () => {
  let resources: TestHarness;
  beforeEach(() => { resources = createTestHarness(); vi.useFakeTimers(); });
  afterEach(() => resources.dispose());

  it("pauses the remaining display window while pinned and keeps the execution owner intact", async () => {
    const completedAt = Date.now();
    const task = reduceTask(createTask("task", "operation", { agent: "worker", model: { provider: "test", id: "model" },
      thinkingLevel: "off", tools: [], cwd: "/project", systemPrompt: "", limits: { graceTurns: 1 } }),
    { type: "settled", operationId: "operation", outcome: { status: "completed", result: "Durable result" } });
    const engine = {
      subscribe: () => () => {}, observe: async () => () => {}, list: () => [task], get: () => task,
      binding: () => ({ display: { name: "Worker", description: "Read a result" } }), close: vi.fn(),
      snapshot: async () => ({ task, execution: { messages: [], queued: [], lastResult: { operationId: "operation", completedAt, startedAt: completedAt },
        stats: { input: 0, output: 0, cost: 0, toolUses: 0, turnCount: 1, compactions: 0, contextPercent: null } } }),
    };
    const source = new TaskNavigationSource(engine as unknown as TaskEngine);
    resources.onDispose(() => source.dispose());
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
