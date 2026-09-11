import { describe, expect, it } from "vitest";
import { createTask, reduceTask } from "../../../src/domain/task.js";
import type { TaskPolicy } from "../../../src/domain/policy.js";
import { Quota } from "../../../src/domain/quota.js";

function policy(): TaskPolicy {
  return {
    agent: "Explore", model: { provider: "provider", id: "model" }, thinkingLevel: "high",
    tools: ["read"], cwd: "/workspace", systemPrompt: "Inspect the project.",
    limits: { maxTurns: 8, graceTurns: 2, maxTokens: 2048 },
  };
}

describe("accepted task policy", () => {
  it("owns execution values while leaving host objects and configuration mutable", () => {
    const model = { provider: "provider", id: "model", hostCallback: () => undefined };
    const tools = ["read"];
    const limits = { maxTurns: 8, graceTurns: 2, maxTokens: 2048 };
    const input = { ...policy(), model, tools, limits };
    const task = createTask("task", "first", input);

    model.provider = "other";
    model.id = "replacement";
    tools.push("write");
    limits.maxTurns = 1;
    limits.maxTokens = 512;
    input.cwd = "/another-workspace";
    input.systemPrompt = "Replace the accepted instructions.";

    expect(task.policy.model).toEqual({ provider: "provider", id: "model" });
    expect(task.policy.tools).toEqual(["read"]);
    expect(task.policy.limits).toEqual({ maxTurns: 8, graceTurns: 2, maxTokens: 2048 });
    expect(task.policy.cwd).toBe("/workspace");
    expect(task.policy.systemPrompt).toBe("Inspect the project.");
    expect(() => (task.policy.tools as string[]).push("bash")).toThrow(TypeError);
    expect(createTask("another-task", "another-operation", input).policy.model)
      .toEqual({ provider: "other", id: "replacement" });
  });
});

describe("task transitions", () => {
  it("keeps control independent from waiting, cancellation, and continuation", () => {
    const initial = createTask("task", "first", policy());
    let task = reduceTask(initial, { type: "started", operationId: "first" });
    task = reduceTask(task, { type: "waiting", operationId: "first" });
    task = reduceTask(task, { type: "takeover" });
    expect(task.control).toBe("manual");
    expect(task.state.status).toBe("waiting");
    task = reduceTask(task, { type: "started", operationId: "first" });
    task = reduceTask(task, { type: "cancel_requested", operationId: "first" });
    expect(task.state.status).toBe("cancelling");
    expect(reduceTask(task, { type: "waiting", operationId: "first" })).toBe(task);
    expect(reduceTask(task, { type: "started", operationId: "first" })).toBe(task);

    task = reduceTask(task, { type: "settled", operationId: "first", outcome: { status: "aborted" } });
    const next = reduceTask(task, { type: "continue", operationId: "second" });
    expect(next.control).toBe("manual");
    expect(next.state).toEqual({ status: "queued" });
    expect(next.policy).toBe(initial.policy);
    expect(initial.state).toEqual({ status: "queued" });
    expect(initial.control).toBe("autonomous");
    expect(task.state).toEqual({ status: "settled", outcome: { status: "aborted" } });
  });

  it("ignores duplicate terminal events and late events from previous operations", () => {
    const initial = createTask("task", "first", policy());
    const outcome = { status: "completed" as const, result: "First result" };
    const completed = reduceTask(initial, { type: "settled", operationId: "first", outcome });
    outcome.result = "Changed by the caller";
    expect(completed.state).toEqual({ status: "settled", outcome: { status: "completed", result: "First result" } });
    expect(reduceTask(completed, {
      type: "settled", operationId: "first", outcome: { status: "error", error: "Late failure" },
    })).toBe(completed);

    let next = reduceTask(completed, { type: "continue", operationId: "second" });
    next = reduceTask(next, { type: "started", operationId: "second" });
    expect(reduceTask(next, { type: "settled", operationId: "first", outcome: { status: "stopped" } })).toBe(next);
    expect(reduceTask(next, { type: "cancel_requested", operationId: "first" })).toBe(next);
    expect(next.state.status).toBe("running");
    expect(next.operationId).toBe("second");
    expect(reduceTask(next, {
      type: "settled", operationId: "second", outcome: { status: "error", error: "Current failure" },
    }).state).toEqual({ status: "settled", outcome: { status: "error", error: "Current failure" } });
  });

  it("rejects a new operation while work is open and rejects reuse of the current operation ID", () => {
    const queued = createTask("task", "first", policy());
    expect(() => reduceTask(queued, { type: "continue", operationId: "second" }))
      .toThrow("Task must settle before starting another operation");
    const settled = reduceTask(queued, {
      type: "settled", operationId: "first", outcome: { status: "error", error: "Setup failed" },
    });
    expect(() => reduceTask(settled, { type: "continue", operationId: "first" }))
      .toThrow("Continuation requires a new operation ID");
  });
});

describe("execution quota", () => {
  it("enforces both ceilings and keeps an old release from freeing a subsequent execution", () => {
    const quota = new Quota({ default: 2, providers: { provider: 2 }, models: { "provider/a": 1 } });
    const a = { provider: "provider", id: "a" };
    const b = { provider: "provider", id: "b" };
    const firstModel = { ...a };
    const releaseFirst = quota.tryAcquire(firstModel)!;
    expect(releaseFirst).toBeDefined();
    expect(quota.tryAcquire(a)).toBeUndefined();
    const releaseB = quota.tryAcquire(b)!;
    expect(releaseB).toBeDefined();
    expect(quota.tryAcquire({ provider: "provider", id: "c" })).toBeUndefined();
    const releaseOther = quota.tryAcquire({ provider: "other", id: "a" })!;
    expect(releaseOther).toBeDefined();

    firstModel.provider = "changed";
    firstModel.id = "changed";
    releaseFirst();
    const releaseNext = quota.tryAcquire(a)!;
    expect(releaseNext).toBeDefined();
    releaseFirst();
    expect(quota.tryAcquire(a)).toBeUndefined();
    expect(quota.tryAcquire({ provider: "provider", id: "c" })).toBeUndefined();
    releaseNext();
    releaseB();
    releaseOther();
  });

  it("publishes valid limits atomically and preserves executions when ceilings decrease", () => {
    const limits = { default: 2, providers: { provider: 2 }, models: { "provider/model": 2 } };
    const quota = new Quota(limits);
    const model = { provider: "provider", id: "model" };
    const releaseFirst = quota.tryAcquire(model)!;
    expect(releaseFirst).toBeDefined();
    limits.providers.provider = 1;
    limits.models["provider/model"] = 1;
    expect(() => quota.setLimits({ default: 1, providers: { provider: 1 }, models: { "provider/model": NaN } }))
      .toThrow(RangeError);
    const releaseSecond = quota.tryAcquire(model)!;
    expect(releaseSecond).toBeDefined();

    quota.setLimits({ default: 1, providers: { provider: 1 } });
    expect(quota.tryAcquire(model)).toBeUndefined();
    releaseFirst();
    expect(quota.tryAcquire(model)).toBeUndefined();
    releaseSecond();
    const releaseThird = quota.tryAcquire(model)!;
    expect(releaseThird).toBeDefined();
    releaseThird();
  });

  it("isolates reservations between instances using the same provider and model", () => {
    const first = new Quota({ default: 1 });
    const second = new Quota({ default: 1 });
    const model = { provider: "provider", id: "model" };
    const releaseFirst = first.tryAcquire(model)!;
    const releaseSecond = second.tryAcquire(model)!;
    expect(releaseFirst).toBeDefined();
    expect(releaseSecond).toBeDefined();
    releaseFirst();
    expect(second.tryAcquire(model)).toBeUndefined();
    const releaseNext = first.tryAcquire(model)!;
    expect(releaseNext).toBeDefined();
    releaseNext();
    releaseSecond();
  });
});
