import { mockRunResult, fakeOptions, disposeManager } from "./manager-test-helpers.js";
import { createTestHarness, type TestHarness } from "../../harness.js";
import type { AgentRecord } from "../../../src/types.js";
/**
 * agent-manager.queue.test.ts — Concurrency ceilings and queue management tests.
 *
 * Covers:
 *   - Per-model limits & per-provider shared limits
 *   - Queueing when ceilings are reached
 *   - Slot releases on completion, clear, or abort
 *   - Dynamic setConcurrency updates
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCtx, fakePi, makeResolvablePromise } from "../../fixtures.js";
import { AgentManager, type ConcurrencyConfig } from "../../../src/agents/agent-manager.js";


const mockModules = vi.hoisted(() => ({
  mockRunAgent: vi.fn(),
  mockContinueAgentSession: vi.fn(),
}));

vi.mock("../../../src/agents/agent-runner.js", () => ({
  runAgent: mockModules.mockRunAgent,
  continueAgentSession: mockModules.mockContinueAgentSession,
}));

describe("AgentManager — Queue & Concurrency", () => {
  let harness: TestHarness;
  let manager: AgentManager;
  let onComplete: any;

  beforeEach(() => {
    harness = createTestHarness();
    harness.onDispose(() => disposeManager(manager));
    mockModules.mockRunAgent.mockReset();
    mockModules.mockContinueAgentSession.mockReset();
    onComplete = vi.fn<(record: AgentRecord) => void>();
  });

  afterEach(async () => { await harness.dispose(); });

  it.each([
    { ceiling: "model", nextModel: "test/first", stopBeforeClear: false },
    { ceiling: "provider", nextModel: "test/second", stopBeforeClear: true },
  ])("releases the $ceiling slot on clear without releasing it twice", async ({ nextModel, stopBeforeClear }) => {
    manager = new AgentManager(onComplete, { default: 1, providers: { test: 1 } });
    const first = makeResolvablePromise();
    const second = makeResolvablePromise();
    const third = makeResolvablePromise();
    mockModules.mockRunAgent
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);

    const firstId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", fakeOptions({
      description: "first", modelKey: "test/first",
    }));
    const firstRun = manager.getRecord(firstId)!.execution.promise;
    const secondId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "second", fakeOptions({
      description: "second", modelKey: nextModel,
    }));
    const thirdId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "third", fakeOptions({
      description: "third", modelKey: nextModel,
    }));
    expect(manager.getRecord(secondId)!.lifecycle.status).toBe("queued");

    if (stopBeforeClear) manager.abort(firstId, "user");
    expect(manager.clear(firstId)).toBe(true);
    expect(manager.getRecord(secondId)!.lifecycle.status).toBe("running");
    expect(manager.getRecord(thirdId)!.lifecycle.status).toBe("queued");

    first.resolve(mockRunResult());
    await firstRun;
    expect(manager.getRecord(thirdId)!.lifecycle.status).toBe("queued");
    expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

    second.resolve(mockRunResult());
    await manager.getRecord(secondId)!.execution.promise;
    expect(manager.getRecord(thirdId)!.lifecycle.status).toBe("running");
    third.resolve(mockRunResult());
    await manager.getRecord(thirdId)!.execution.promise;
  });

  it("releases a cleared continuation slot only once", async () => {
    manager = new AgentManager(onComplete, { default: 1 });
    const next = makeResolvablePromise();
    const continuation = makeResolvablePromise();
    mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult()).mockReturnValue(next.promise);
    mockModules.mockContinueAgentSession.mockReturnValue(continuation.promise);
    const options = { description: "task", modelKey: "test/model" };
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", fakeOptions(options));
    await manager.getRecord(id)!.execution.promise;
    expect(await manager.interact(id, "continue")).toEqual({ accepted: true });
    const continuationRun = manager.getRecord(id)!.execution.promise;
    const nextId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "next", fakeOptions(options));

    manager.clear(id);
    expect(manager.getRecord(nextId)!.lifecycle.status).toBe("running");
    const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "queued", fakeOptions(options));
    continuation.resolve({ responseText: "late", aborted: true, turnLimited: false });
    await continuationRun;
    expect(manager.getRecord(queuedId)!.lifecycle.status).toBe("queued");

    manager.abort(queuedId);
    next.resolve(mockRunResult());
    await manager.getRecord(nextId)!.execution.promise;
  });

  it("starts all agents when under per-model limit", () => {
    const config: ConcurrencyConfig = { default: 4, models: {} };
    manager = new AgentManager(onComplete, config);
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

    const ctx = fakeCtx();
    const pi = fakePi();

    const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", fakeOptions({ description: "task 1", modelKey: "llamacpp/4b_small" }));
    const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", fakeOptions({ description: "task 2", modelKey: "llamacpp/4b_small" }));
    const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", fakeOptions({ description: "task 3", modelKey: "llamacpp/4b_small" }));

    expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
    expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
    expect(manager.getRecord(id3)?.lifecycle.status).toBe("running");
    expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(3);
  });

  it("queues agents when per-model limit is reached", () => {
    const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b_small": 1 } };
    manager = new AgentManager(onComplete, config);

    const deferred = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(deferred.promise);

    const ctx = fakeCtx();
    const pi = fakePi();

    const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", fakeOptions({ description: "task 1", modelKey: "llamacpp/4b_small" }));
    const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", fakeOptions({ description: "task 2", modelKey: "llamacpp/4b_small" }));

    expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
    expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");
    expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);

    deferred.resolve(mockRunResult());
  });

  it("starts queued agent when running agent completes", async () => {
    const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b_small": 1 } };
    manager = new AgentManager(onComplete, config);

    const deferred1 = makeResolvablePromise();
    const deferred2 = makeResolvablePromise();
    mockModules.mockRunAgent
      .mockReturnValueOnce(deferred1.promise)
      .mockReturnValueOnce(deferred2.promise);

    const ctx = fakeCtx();
    const pi = fakePi();

    const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", fakeOptions({ description: "task 1", modelKey: "llamacpp/4b_small" }));
    const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", fakeOptions({ description: "task 2", modelKey: "llamacpp/4b_small" }));

    expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");

    deferred1.resolve(mockRunResult());
    await manager.getRecord(id1)!.execution.promise;

    expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
    expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

    deferred2.resolve(mockRunResult());
  });

  it("enforces the Provider ceiling across models even when individual limits are higher", async () => {
    manager = new AgentManager(onComplete, {
      default: 4,
      providers: { llamacpp: 2 },
      models: { "llamacpp/4b": 4, "llamacpp/27b": 4 },
    });
    const first = makeResolvablePromise();
    const second = makeResolvablePromise();
    const third = makeResolvablePromise();
    mockModules.mockRunAgent
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);

    const firstId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", fakeOptions({
      description: "first",
      modelKey: "llamacpp/4b",
    }));
    manager.spawn(fakePi(), fakeCtx(), "general-purpose", "second", fakeOptions({
      description: "second",
      modelKey: "llamacpp/27b",
    }));
    const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "third", fakeOptions({
      description: "third",
      modelKey: "llamacpp/4b",
    }));

    expect(manager.getRecord(queuedId)?.lifecycle.status).toBe("queued");
    expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

    first.resolve(mockRunResult());
    await manager.getRecord(firstId)!.execution.promise;
    expect(manager.getRecord(queuedId)?.lifecycle.status).toBe("running");
    expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(3);

    second.resolve(mockRunResult());
    third.resolve(mockRunResult());
  });

  it("applies new limit when setConcurrency is called", () => {
    const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b": 1 } };
    manager = new AgentManager(onComplete, config);

    const deferred = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(deferred.promise);

    const ctx = fakeCtx();
    const pi = fakePi();

    manager.spawn(pi, ctx, "general-purpose", "task 1", fakeOptions({ description: "task 1", modelKey: "llamacpp/4b" }));
    const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", fakeOptions({ description: "task 2", modelKey: "llamacpp/4b" }));

    expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");

    manager.setConcurrency({ default: 1, models: { "llamacpp/4b": 2 } });

    expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
    expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

    deferred.resolve(mockRunResult());
  });

  it("queues agents per-model independently", () => {
      const config: ConcurrencyConfig = {
        default: 4,
        models: { "llamacpp/27b": 1, "llamacpp/4b": 4 },
      };
      manager = new AgentManager(onComplete, config);

      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      const deferred3 = makeResolvablePromise();
      mockModules.mockRunAgent
        .mockReturnValueOnce(deferred1.promise)
        .mockReturnValueOnce(deferred2.promise)
        .mockReturnValueOnce(deferred3.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", fakeOptions({ description: "task 1", modelKey: "llamacpp/27b" }));
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", fakeOptions({ description: "task 2", modelKey: "llamacpp/4b" }));
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", fakeOptions({ description: "task 3", modelKey: "llamacpp/27b" }));

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

      deferred1.resolve(mockRunResult());
      deferred2.resolve(mockRunResult());
      deferred3.resolve(mockRunResult());
    });

  it("applies default limit for unknown models", () => {
      const config: ConcurrencyConfig = { default: 2, models: {} };
      manager = new AgentManager(onComplete, config);

      const deferred1 = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred1.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", fakeOptions({ description: "task 1", modelKey: "claude/sonnet" }));
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", fakeOptions({ description: "task 2", modelKey: "claude/sonnet" }));
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", fakeOptions({ description: "task 3", modelKey: "claude/sonnet" }));

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

      deferred1.resolve(mockRunResult());
    });

  it("enforces a model ceiling inside the shared Provider ceiling", () => {
      const config: ConcurrencyConfig = {
        default: 4,
        providers: { llamacpp: 2 },
        models: { "llamacpp/4b": 1 },
      };
      manager = new AgentManager(onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", fakeOptions({ description: "task 1", modelKey: "llamacpp/4b" }));
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", fakeOptions({ description: "task 2", modelKey: "llamacpp/4b" }));

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);

      deferred.resolve(mockRunResult());
    });

  it("queues foreground agent when limit is reached", async () => {
      const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b": 1 } };
      manager = new AgentManager(onComplete, config);

      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      mockModules.mockRunAgent
        .mockReturnValueOnce(deferred1.promise)
        .mockReturnValueOnce(deferred2.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "bg task", fakeOptions({ description: "bg task", modelKey: "llamacpp/4b" }));
      const id2 = manager.spawn(pi, ctx, "general-purpose", "fg task", fakeOptions({ description: "fg task", modelKey: "llamacpp/4b" }));

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);

      deferred1.resolve(mockRunResult());
      await manager.getRecord(id1)!.execution.promise;

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);
      deferred2.resolve(mockRunResult());
      await manager.getRecord(id2)!.execution.promise;
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("completed");
    });
});
