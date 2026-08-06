/**
 * agent-manager.test.ts — Tests for AgentManager.
 *
 * Covers concurrency, queueing, interaction, cleanup, and child-session shutdown.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeCtx, fakePi, makeResolvablePromise } from "../fixtures.ts";

let uuidCounter = 0;

const mockModules = vi.hoisted(() => ({
  mockRunAgent: vi.fn(),
  mockContinueAgentSession: vi.fn(),
  mockRandomUUID: vi.fn(() => {
    uuidCounter++;
    return `agent-${String(uuidCounter).padStart(8, "0")}`;
  }),
  resetUuidCounter: () => { uuidCounter = 0; },
}));

vi.mock("node:crypto", () => ({
  randomUUID: mockModules.mockRandomUUID,
}));

vi.mock("../../src/agents/agent-runner.js", () => ({
  runAgent: mockModules.mockRunAgent,
  continueAgentSession: mockModules.mockContinueAgentSession,
}));

function mockAgentSession(): any {
  return {
    subscribe: vi.fn(() => vi.fn()),
    messages: [],
    isStreaming: false,
    dispose: vi.fn(),
    steer: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    extensionRunner: { emit: vi.fn().mockResolvedValue(undefined) },
  };
}

/** Emitted shutdown events for a mock session, in emit order. */
function shutdownEvents(session: any): any[] {
  return session.extensionRunner.emit.mock.calls
    .map(([event]: [any]) => event)
    .filter((event: any) => event?.type === "session_shutdown");
}

function mockRunResult(overrides?: Partial<ReturnType<typeof mockRunResult>>) {
  return {
    responseText: "done",
    session: mockAgentSession(),
    aborted: false,
    turnLimited: false,
    ...overrides,
  };
}

import { AgentManager } from "../../src/agents/agent-manager.js";
import type { ConcurrencyConfig } from "../../src/agents/agent-manager.js";

describe("AgentManager", () => {
  let manager: AgentManager;
  let onComplete: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockModules.resetUuidCounter();
    mockModules.mockRunAgent.mockReset();
    mockModules.mockContinueAgentSession.mockReset();
    onComplete = vi.fn();
  });

  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  // ── Concurrency ──

  describe("concurrency", () => {
    it("starts all agents when under per-model limit", () => {
      const config: ConcurrencyConfig = { default: 4, models: {} };
      manager = new AgentManager(onComplete, config);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", { description: "task 1", modelKey: "llamacpp/4b_small" });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", { description: "task 2", modelKey: "llamacpp/4b_small" });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", { description: "task 3", modelKey: "llamacpp/4b_small" });

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

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", { description: "task 1", modelKey: "llamacpp/4b_small" });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", { description: "task 2", modelKey: "llamacpp/4b_small" });

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

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", { description: "task 1", modelKey: "llamacpp/4b_small" });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", { description: "task 2", modelKey: "llamacpp/4b_small" });

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");

      deferred1.resolve(mockRunResult());
      // finally() drains the queue on the same promise chain — no wall-clock wait.
      await manager.getRecord(id1)!.execution.promise;

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

      deferred2.resolve(mockRunResult());
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

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", { description: "task 1", modelKey: "llamacpp/27b" });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", { description: "task 2", modelKey: "llamacpp/4b" });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", { description: "task 3", modelKey: "llamacpp/27b" });

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

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", { description: "task 1", modelKey: "claude/sonnet" });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", { description: "task 2", modelKey: "claude/sonnet" });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", { description: "task 3", modelKey: "claude/sonnet" });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

      deferred1.resolve(mockRunResult());
    });

    it("applies per-provider limit to all models from that provider", () => {
      const config: ConcurrencyConfig = {
        default: 4,
        providers: { llamacpp: 2 },
        models: {},
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

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", { description: "task 1", modelKey: "llamacpp/4b" });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", { description: "task 2", modelKey: "llamacpp/27b" });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", { description: "task 3", modelKey: "llamacpp/3b" });
      const id4 = manager.spawn(pi, ctx, "general-purpose", "task 4", { description: "task 4", modelKey: "claude/sonnet" });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("queued");
      expect(manager.getRecord(id4)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(3);

      deferred1.resolve(mockRunResult());
      deferred2.resolve(mockRunResult());
      deferred3.resolve(mockRunResult());
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

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", { description: "task 1", modelKey: "llamacpp/4b" });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", { description: "task 2", modelKey: "llamacpp/4b" });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);

      deferred.resolve(mockRunResult());
    });

    it("enforces the Provider ceiling across models even when their individual limits are higher", async () => {
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

      const firstId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", {
        description: "first",
        modelKey: "llamacpp/4b",
      });
      manager.spawn(fakePi(), fakeCtx(), "general-purpose", "second", {
        description: "second",
        modelKey: "llamacpp/27b",
      });
      const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "third", {
        description: "third",
        modelKey: "llamacpp/4b",
      });

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

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", { description: "task 1", modelKey: "llamacpp/4b" });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", { description: "task 2", modelKey: "llamacpp/4b" });

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");

      manager.setConcurrency({ default: 1, models: { "llamacpp/4b": 2 } });

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

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

      const id1 = manager.spawn(pi, ctx, "general-purpose", "bg task", { description: "bg task", modelKey: "llamacpp/4b" });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "fg task", { description: "fg task", modelKey: "llamacpp/4b" });

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

  it("returns a shutdown error when a queued foreground agent is disposed", async () => {
    manager = new AgentManager(onComplete, {
      default: 1,
      models: { "test/model": 1 },
    });
    const blocker = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(blocker.promise);

    const blockerId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "blocker", {
      description: "blocker",
      modelKey: "test/model",
    });
    const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "queued", {
      description: "queued",
      modelKey: "test/model",
    });
    const queuedRecord = manager.getRecord(queuedId)!;
    const queuedWait = queuedRecord.execution.promise!;

    await manager.dispose();
    await queuedWait;

    expect(queuedRecord.lifecycle.status).toBe("error");
    expect(queuedRecord.error).toContain("manager disposed");
    blocker.resolve(mockRunResult());
    await manager.getRecord(blockerId)?.execution.promise;
  });

  it("aborts a running setup before disposing the manager", async () => {
    const deferred = makeResolvablePromise();
    let signal: AbortSignal | undefined;
    mockModules.mockRunAgent.mockImplementationOnce((_ctx: any, _type: string, _prompt: string, options: any) => {
      signal = options.signal;
      return deferred.promise;
    });

    manager = new AgentManager(onComplete);
    manager.spawn(fakePi(), fakeCtx(), "general-purpose", "running", {
      description: "running",
      modelKey: "test/model",
    });

    await manager.dispose();
    expect(signal?.aborted).toBe(true);
    deferred.resolve(mockRunResult());
  });

  it("stops waiting when child session setup never settles", async () => {
    vi.useFakeTimers();
    mockModules.mockRunAgent.mockImplementationOnce(async (_ctx: any, _type: string, _prompt: string, options: any) => {
      options.onSessionSetupStarted();
      await new Promise(() => {});
      return mockRunResult();
    });

    manager = new AgentManager(onComplete);
    manager.spawn(fakePi(), fakeCtx(), "general-purpose", "stuck setup", {
      description: "stuck setup",
      modelKey: "test/model",
    });

    let disposed = false;
    const disposal = manager.dispose().then(() => { disposed = true; });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(disposed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await disposal;
    expect(disposed).toBe(true);
  });

  it("closes a child session that finishes setup after disposal", async () => {
    const setup = makeResolvablePromise();
    const session = mockAgentSession();
    mockModules.mockRunAgent.mockImplementationOnce(async (_ctx: any, _type: string, _prompt: string, options: any) => {
      options.onSessionSetupStarted();
      await setup.promise;
      await options.onSessionCreated(session);
      options.onSessionSetupFinished();
      return mockRunResult({ session });
    });

    manager = new AgentManager(onComplete);
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "late setup", {
      description: "late setup",
      modelKey: "test/model",
    });
    const run = manager.getRecord(id)!.execution.promise!;

    const disposal = manager.dispose();
    setup.resolve(undefined);
    await disposal;
    await run;

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("closes a child session that finishes setup after the record is cleared", async () => {
    const setup = makeResolvablePromise();
    const session = mockAgentSession();
    mockModules.mockRunAgent.mockImplementationOnce(async (_ctx: any, _type: string, _prompt: string, options: any) => {
      options.onSessionSetupStarted();
      await setup.promise;
      await options.onSessionCreated(session);
      options.onSessionSetupFinished();
      return mockRunResult({ session });
    });

    manager = new AgentManager(onComplete);
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "cleared setup", {
      description: "cleared setup",
      modelKey: "test/model",
    });
    const run = manager.getRecord(id)!.execution.promise!;

    expect(manager.clear(id)).toBe(true);
    setup.resolve(undefined);
    await run;

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("settles a foreground wait when a queued agent is stopped", async () => {
    manager = new AgentManager(onComplete, {
      default: 1,
      models: { "test/model": 1 },
    });
    const blocker = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(blocker.promise);

    const blockerId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "blocker", {
      description: "blocker",
      modelKey: "test/model",
    });
    const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "queued", {
      description: "queued",
      modelKey: "test/model",
    });
    const queuedWait = manager.getRecord(queuedId)!.execution.promise!;

    expect(manager.abort(queuedId, "user")).toBe(true);
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      id: queuedId,
      lifecycle: expect.objectContaining({ status: "stopped" }),
    }));
    await queuedWait;

    expect(manager.getRecord(queuedId)?.lifecycle.status).toBe("stopped");
    blocker.resolve(mockRunResult());
    await manager.getRecord(blockerId)!.execution.promise;
  });

  it("stops all running agents bound to the interrupted parent turn", async () => {
    manager = new AgentManager(onComplete);
    const first = makeResolvablePromise();
    const second = makeResolvablePromise();
    mockModules.mockRunAgent
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const controller = new AbortController();

    const firstId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", {
      description: "first",
      signal: controller.signal,
    });
    const secondId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "second", {
      description: "second",
      signal: controller.signal,
    });
    const firstWait = manager.getRecord(firstId)!.execution.promise!;
    const secondWait = manager.getRecord(secondId)!.execution.promise!;

    controller.abort();

    expect(manager.getRecord(firstId)?.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "user" });
    expect(manager.getRecord(secondId)?.lifecycle).toMatchObject({ status: "stopped", stoppedBy: "user" });
    expect(mockModules.mockRunAgent.mock.calls[0][3].signal.aborted).toBe(true);
    expect(mockModules.mockRunAgent.mock.calls[1][3].signal.aborted).toBe(true);

    first.resolve(mockRunResult({ responseText: "", aborted: true }));
    second.resolve(mockRunResult({ responseText: "", aborted: true }));
    await Promise.all([firstWait, secondWait]);
  });

  it("cancels a queued agent when its parent turn is interrupted", async () => {
    manager = new AgentManager(onComplete, {
      default: 1,
      models: { "test/model": 1 },
    });
    const blocker = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(blocker.promise);
    const controller = new AbortController();

    const blockerId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "blocker", {
      description: "blocker",
      modelKey: "test/model",
    });
    const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "queued", {
      description: "queued",
      modelKey: "test/model",
      signal: controller.signal,
    });
    const queuedWait = manager.getRecord(queuedId)!.execution.promise!;

    controller.abort();
    await queuedWait;

    expect(manager.getRecord(queuedId)).toMatchObject({
      lifecycle: { status: "stopped", stoppedBy: "user" },
      execution: { settled: true },
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    blocker.resolve(mockRunResult());
    await manager.getRecord(blockerId)!.execution.promise;
    expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it("keeps concurrency reserved until an interrupted run actually settles", async () => {
    manager = new AgentManager(onComplete, {
      default: 1,
      models: { "test/model": 1 },
    });
    const first = makeResolvablePromise();
    const second = makeResolvablePromise();
    mockModules.mockRunAgent
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const controller = new AbortController();

    const firstId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", {
      description: "first",
      modelKey: "test/model",
      signal: controller.signal,
    });
    const secondId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "second", {
      description: "second",
      modelKey: "test/model",
    });

    controller.abort();
    expect(manager.getRecord(firstId)?.lifecycle.status).toBe("stopped");
    expect(manager.getRecord(secondId)?.lifecycle.status).toBe("queued");
    expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();

    first.resolve(mockRunResult({ responseText: "", aborted: true }));
    await manager.getRecord(firstId)!.execution.promise;
    expect(manager.getRecord(secondId)?.lifecycle.status).toBe("running");
    expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledTimes(1);

    second.resolve(mockRunResult());
    await manager.getRecord(secondId)!.execution.promise;
  });

  it("detaches the parent signal before a later continuation", async () => {
    manager = new AgentManager(onComplete);
    const session = mockAgentSession();
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));
    const controller = new AbortController();

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "initial", {
      description: "initial",
      signal: controller.signal,
    });
    const record = manager.getRecord(id)!;
    await record.execution.promise;

    const continuation = makeResolvablePromise();
    mockModules.mockContinueAgentSession.mockReturnValueOnce(continuation.promise);
    expect(await manager.interact(id, "continue")).toEqual({ accepted: true });

    controller.abort();
    expect(record.lifecycle.status).toBe("running");
    expect(session.abort).not.toHaveBeenCalled();

    continuation.resolve({ responseText: "continued", aborted: false, turnLimited: false });
    await record.execution.promise;
    expect(record.lifecycle.status).toBe("completed");
  });

  it("does not start an agent whose parent signal is already aborted", () => {
    manager = new AgentManager(onComplete);
    const controller = new AbortController();
    controller.abort();

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "cancelled", {
      description: "cancelled",
      signal: controller.signal,
    });

    expect(manager.getRecord(id)).toMatchObject({
      lifecycle: { status: "stopped", stoppedBy: "user" },
      execution: { settled: true },
    });
    expect(mockModules.mockRunAgent).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(manager.getRecord(id));
  });

  // ── Completion contract ──

  describe("completion contract", () => {
    it("records provider failures instead of completing with an empty result", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockRejectedValue(new Error("503 service_unavailable"));

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      expect(record.lifecycle.status).toBe("error");
      expect(record.error).toBe("503 service_unavailable");
      expect(record.result).toBeUndefined();
      expect(onComplete).toHaveBeenCalledWith(record);
    });

    it("waits to notify a recoverable failure until its recovery window expires", async () => {
      vi.useFakeTimers();
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      mockModules.mockRunAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
        options.onSessionCreated(session);
        throw new Error("stream_read_error: response closed");
      });

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      await manager.getRecord(id)!.execution.promise;

      expect(onComplete).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30 * 60_000);

      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
        id,
        lifecycle: expect.objectContaining({ status: "error" }),
        error: expect.stringContaining("Agent recovery expired without continuation"),
      }));
      expect(manager.getRecord(id)).toBeUndefined();
    });
  });

  // ── Direct interaction ──

  describe("interact", () => {
    it("steers a running agent", async () => {
      manager = new AgentManager(onComplete);
      const deferred = makeResolvablePromise();
      const session = mockAgentSession();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      record.execution.session = session;

      await expect(manager.interact(id, "new direction")).resolves.toEqual({ accepted: true });
      expect(session.steer).toHaveBeenCalledWith("new direction", undefined);

      deferred.resolve(mockRunResult({ session }));
    });

    it("forwards images when steering a running agent", async () => {
      manager = new AgentManager(onComplete);
      const deferred = makeResolvablePromise();
      const session = mockAgentSession();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);
      const images = [{ type: "image", data: "abc", mimeType: "image/png" }] as any;

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      manager.getRecord(id)!.execution.session = session;

      await expect(manager.interact(id, "inspect this", images)).resolves.toEqual({ accepted: true });
      expect(session.steer).toHaveBeenCalledWith("inspect this", images);

      deferred.resolve(mockRunResult({ session }));
    });

    it("resumes a settled agent session", async () => {
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));
      mockModules.mockContinueAgentSession.mockResolvedValue({
        responseText: "continued result",
        aborted: false,
        turnLimited: false,
      });

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      await expect(manager.interact(id, "continue")).resolves.toEqual({ accepted: true });
      await record.execution.promise;

      expect(mockModules.mockContinueAgentSession).toHaveBeenCalledWith(
        session,
        "continue",
        expect.objectContaining({
          onToolUse: expect.any(Function),
          onTurnEnd: expect.any(Function),
        }),
      );
      expect(record.lifecycle.status).toBe("completed");
      expect(record.result).toBe("continued result");
      expect(mockModules.mockContinueAgentSession).toHaveBeenCalledWith(
        session,
        "continue",
        expect.objectContaining({
          maxTurns: record.stats.maxTurns,
          graceTurns: record.execution.graceTurns,
        }),
      );
    });

    it("handles abort rejection while stopping a resumed session", async () => {
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));
      const continuation = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(continuation.promise);

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      const abortPromise = Promise.reject(new Error("already aborting"));
      abortPromise.catch(() => {});
      const abortCatch = vi.spyOn(abortPromise, "catch");
      session.abort = vi.fn(() => abortPromise);

      await expect(manager.interact(id, "continue")).resolves.toEqual({ accepted: true });
      expect(manager.abort(id, "user")).toBe(true);
      expect(session.abort).toHaveBeenCalled();
      expect(abortCatch).toHaveBeenCalled();

      continuation.resolve({ responseText: "", aborted: true, turnLimited: false });
      await record.execution.promise;
      expect(record.lifecycle.status).toBe("stopped");
    });

    it("continues a failed live session through the existing interaction path", async () => {
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      mockModules.mockRunAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
        options.onSessionCreated(session);
        throw new Error("content was flagged");
      });
      const continuation = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(continuation.promise);

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      expect(record.lifecycle.status).toBe("error");
      await expect(manager.interact(id, "Provide a defensive-only summary")).resolves.toEqual({ accepted: true });
      expect(record.lifecycle.status).toBe("running");
      expect(mockModules.mockContinueAgentSession).toHaveBeenCalledWith(
        session,
        "Provide a defensive-only summary",
        expect.objectContaining({
          maxTurns: record.stats.maxTurns,
          graceTurns: record.execution.graceTurns,
        }),
      );

      continuation.resolve({ responseText: "defensive summary", aborted: false, turnLimited: false });
      await record.execution.promise;

      expect(record.lifecycle.status).toBe("completed");
      expect(record.result).toBe("defensive summary");
    });

    it("rejects a stopped agent until its previous execution settles", async () => {
      manager = new AgentManager(onComplete);
      const deferred = makeResolvablePromise();
      const session = mockAgentSession();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      record.execution.session = session;
      manager.abort(id, "user");

      await expect(manager.interact(id, "resume too early")).resolves.toEqual({ accepted: false, reason: "unavailable" });
      expect(mockModules.mockContinueAgentSession).not.toHaveBeenCalled();

      deferred.resolve(mockRunResult({ session, aborted: true }));
    });

    it("respects model concurrency when resuming a settled agent", async () => {
      manager = new AgentManager(onComplete, {
        default: 1,
        models: { "test/model": 1 },
      });
      const firstSession = mockAgentSession();
      mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult({ session: firstSession }));

      const firstId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", {
        description: "first",
        modelKey: "test/model",
      });
      await manager.getRecord(firstId)!.execution.promise;

      const secondDeferred = makeResolvablePromise();
      const secondSession = mockAgentSession();
      mockModules.mockRunAgent.mockReturnValueOnce(secondDeferred.promise);
      manager.spawn(fakePi(), fakeCtx(), "general-purpose", "second", {
        description: "second",
        modelKey: "test/model",
      });

      await expect(manager.interact(firstId, "resume")).resolves.toEqual({
        accepted: false,
        reason: "concurrency",
        modelKey: "test/model",
      });
      expect(mockModules.mockContinueAgentSession).not.toHaveBeenCalled();

      secondDeferred.resolve(mockRunResult({ session: secondSession }));
    });

    it("keeps a fault-bound expiry when a full model slot rejects continuation", async () => {
      vi.useFakeTimers();
      manager = new AgentManager(onComplete, {
        default: 1,
        models: { "test/model": 1 },
      });
      const failedSession = mockAgentSession();
      mockModules.mockRunAgent.mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
        options.onSessionCreated(failedSession);
        throw new Error("debug injected: content was flagged");
      });
      manager.armDebugFault("output_blocked");

      const failedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "failed", {
        description: "failed",
        modelKey: "test/model",
      });
      const failedRecord = manager.getRecord(failedId)!;
      await failedRecord.execution.promise;

      const blocker = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(blocker.promise);
      const blockerId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "blocker", {
        description: "blocker",
        modelKey: "test/model",
      });

      await expect(manager.interact(failedId, "continue")).resolves.toEqual({
        accepted: false,
        reason: "concurrency",
        modelKey: "test/model",
      });
      expect(failedRecord.execution.recoveryTtlMs).toBe(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(manager.getRecord(failedId)).toBeUndefined();

      blocker.resolve(mockRunResult());
      await manager.getRecord(blockerId)!.execution.promise;
    });

    it("rejects interaction for queued agents", async () => {
      manager = new AgentManager(onComplete, {
        default: 1,
        models: { "test/model": 1 },
      });
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", {
        description: "first",
        modelKey: "test/model",
      });
      const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "second", {
        description: "second",
        modelKey: "test/model",
      });

      await expect(manager.interact(queuedId, "hello")).resolves.toEqual({ accepted: false, reason: "queued" });
      deferred.resolve(mockRunResult());
    });
  });

  // ── Cleanup eviction ──

  describe("cleanup", () => {
    it("preserves unconsumed completed records older than the cutoff", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      // Result never consumed by the LLM — must not be evicted, even when old.
      record.lifecycle.completedAt = Date.now() - 20 * 60_000;
      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeDefined();
    });

    it("evicts persisted background records older than the cutoff", async () => {
      manager = new AgentManager(onComplete);
      const onRemove = vi.fn();
      manager.setOnRemove(onRemove);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
        resultSessionId: "parent-session",
        resultOriginEntryId: "origin-a",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      record.lifecycle.resultPersisted = true;
      record.lifecycle.completedAt = Date.now() - 20 * 60_000;
      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeUndefined();
      expect(onRemove).toHaveBeenCalledWith(record);
    });

    it("evicts consumed completed records older than the cutoff", async () => {
      manager = new AgentManager(onComplete);
      const onRemove = vi.fn();
      manager.setOnRemove(onRemove);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      // Once the LLM has read the result, the record is safe to evict when old.
      record.lifecycle.resultConsumed = true;
      record.lifecycle.completedAt = Date.now() - 20 * 60_000;
      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeUndefined();
      expect(onRemove).toHaveBeenCalledWith(record);
    });

    it("pins multiple completed records and resumes each remaining cleanup window", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const firstId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", {
        description: "first",
        modelKey: "test/model",
      });
      const secondId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "second", {
        description: "second",
        modelKey: "test/model",
      });
      await Promise.all([
        manager.getRecord(firstId)!.execution.promise,
        manager.getRecord(secondId)!.execution.promise,
      ]);

      const completedAt = Date.now() - 9 * 60_000;
      for (const id of [firstId, secondId]) {
        const record = manager.getRecord(id)!;
        record.lifecycle.completedAt = completedAt;
        record.lifecycle.resultConsumed = true;
        expect(manager.togglePinned(id)).toBe(true);
      }

      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(manager.getRecord(firstId)).toBeDefined();
      expect(manager.getRecord(secondId)).toBeDefined();

      expect(manager.togglePinned(firstId)).toBe(false);
      (manager as any).cleanup();
      expect(manager.getRecord(firstId)).toBeDefined();
      await vi.advanceTimersByTimeAsync(60_001);
      (manager as any).cleanup();
      expect(manager.getRecord(firstId)).toBeUndefined();
      expect(manager.getRecord(secondId)).toBeDefined();
      expect(manager.clear(secondId)).toBe(true);
      expect(manager.getRecord(secondId)).toBeUndefined();
    });

    it("starts a full cleanup window after a run pinned before completion is unpinned", async () => {
      vi.useFakeTimers();
      manager = new AgentManager(onComplete);
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      expect(manager.togglePinned(id)).toBe(true);
      deferred.resolve(mockRunResult());
      await manager.getRecord(id)!.execution.promise;
      manager.getRecord(id)!.lifecycle.resultConsumed = true;

      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(manager.getRecord(id)).toBeDefined();
      expect(manager.togglePinned(id)).toBe(false);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      (manager as any).cleanup();
      expect(manager.getRecord(id)).toBeDefined();
      await vi.advanceTimersByTimeAsync(1);
      (manager as any).cleanup();
      expect(manager.getRecord(id)).toBeUndefined();
    });

    it("retains failed live sessions within the 30-minute recovery window", async () => {
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      mockModules.mockRunAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
        options.onSessionCreated(session);
        throw new Error("content was flagged");
      });

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;
      // Past the normal 10-minute cutoff, still inside the 30-minute recovery window.
      record.lifecycle.completedAt = Date.now() - 20 * 60_000;
      record.execution.recoveryExpiresAt = undefined;

      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBe(record);
      expect(record.lifecycle.status).toBe("error");
      expect(record.execution.session).toBe(session);
    });

    it("evicts failed live sessions after the 30-minute recovery window", async () => {
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      mockModules.mockRunAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
        options.onSessionCreated(session);
        throw new Error("content was flagged");
      });

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;
      record.lifecycle.completedAt = Date.now() - 31 * 60_000;
      record.execution.recoveryExpiresAt = undefined;

      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeUndefined();
    });

    it("consumes a Debug fault on the next agent start only", async () => {
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      const runOptions: any[] = [];
      mockModules.mockRunAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
        runOptions.push(options);
        options.onSessionCreated(session);
        return mockRunResult({ session });
      });

      manager.armDebugFault("output_blocked");
      const firstId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", {
        description: "first",
        modelKey: "test/model",
      });
      await manager.getRecord(firstId)!.execution.promise;
      const secondId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "second", {
        description: "second",
        modelKey: "test/model",
      });
      await manager.getRecord(secondId)!.execution.promise;

      expect(runOptions[0].debugFault).toBe("output_blocked");
      expect(runOptions[1].debugFault).toBeUndefined();
      expect(manager.getRecord(firstId)!.execution).toMatchObject({
        debugFaultKind: "output_blocked",
        recoveryTtlMs: 10_000,
      });
      expect(manager.debugDiagnostics().armedFault).toBeUndefined();
    });

    it("keeps a fault armed while agents are queued and consumes it once at start", async () => {
      manager = new AgentManager(onComplete, {
        default: 1,
        models: { "test/model": 1 },
      });
      const blocker = makeResolvablePromise();
      const runOptions: any[] = [];
      mockModules.mockRunAgent.mockImplementation((_ctx, _type, _prompt, options) => {
        runOptions.push(options);
        if (runOptions.length === 1) return blocker.promise;
        const session = mockAgentSession();
        options.onSessionCreated(session);
        return Promise.resolve(mockRunResult({ session }));
      });

      const blockerId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "blocker", {
        description: "blocker",
        modelKey: "test/model",
      });
      manager.armDebugFault("output_blocked");
      const firstQueuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first queued", {
        description: "first queued",
        modelKey: "test/model",
      });
      const secondQueuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "second queued", {
        description: "second queued",
        modelKey: "test/model",
      });

      expect(manager.getRecord(firstQueuedId)!.lifecycle.status).toBe("queued");
      expect(manager.getRecord(secondQueuedId)!.lifecycle.status).toBe("queued");
      expect(manager.debugDiagnostics().armedFault?.kind).toBe("output_blocked");

      blocker.resolve(mockRunResult());
      await manager.getRecord(blockerId)!.execution.promise;
      await manager.getRecord(firstQueuedId)!.execution.promise;
      await manager.getRecord(secondQueuedId)!.execution.promise;

      expect(runOptions.map(options => options.debugFault)).toEqual([
        undefined,
        "output_blocked",
        undefined,
      ]);
      expect(manager.getRecord(firstQueuedId)!.execution.debugFaultKind).toBe("output_blocked");
      expect(manager.getRecord(secondQueuedId)!.execution.debugFaultKind).toBeUndefined();
      expect(manager.debugDiagnostics().armedFault).toBeUndefined();
    });

    it("clears an armed fault before a queued agent starts", async () => {
      manager = new AgentManager(onComplete, {
        default: 1,
        models: { "test/model": 1 },
      });
      const blocker = makeResolvablePromise();
      const runOptions: any[] = [];
      mockModules.mockRunAgent.mockImplementation((_ctx, _type, _prompt, options) => {
        runOptions.push(options);
        if (runOptions.length === 1) return blocker.promise;
        const session = mockAgentSession();
        options.onSessionCreated(session);
        return Promise.resolve(mockRunResult({ session }));
      });

      const blockerId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "blocker", {
        description: "blocker",
        modelKey: "test/model",
      });
      manager.armDebugFault("provider_error");
      const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "queued", {
        description: "queued",
        modelKey: "test/model",
      });
      manager.clearDebugFault();

      blocker.resolve(mockRunResult());
      await manager.getRecord(blockerId)!.execution.promise;
      await manager.getRecord(queuedId)!.execution.promise;

      expect(runOptions[1].debugFault).toBeUndefined();
      expect(manager.getRecord(queuedId)!.execution.debugFaultKind).toBeUndefined();
    });

    it("does not mark setup failures as injected Debug faults", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockRejectedValue(new Error("model unavailable"));
      manager.armDebugFault("provider_error");

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      await manager.getRecord(id)!.execution.promise;

      expect(manager.getRecord(id)!.execution.debugFaultKind).toBeUndefined();
      expect(manager.getRecord(id)!.execution.recoveryTtlMs).toBeUndefined();
      expect(manager.debugDiagnostics().armedFault).toBeUndefined();
    });

    it("starts a fault-injected recovery TTL when the failure completes", async () => {
      vi.useFakeTimers();
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      let rejectRun!: (error: Error) => void;
      mockModules.mockRunAgent.mockImplementation((_ctx, _type, _prompt, options) => {
        options.onSessionCreated(session);
        return new Promise((_resolve, reject) => {
          rejectRun = reject;
        });
      });
      manager.armDebugFault("output_blocked");

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;

      await vi.advanceTimersByTimeAsync(30_000);
      expect(record.lifecycle.status).toBe("running");
      rejectRun(new Error("debug injected: content was flagged"));
      await manager.getRecord(id)!.execution.promise;

      await vi.advanceTimersByTimeAsync(9_999);
      expect(manager.getRecord(id)).toBeDefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.getRecord(id)).toBeUndefined();
    });

    it("pauses a recoverable expiry while its child view is active", async () => {
      vi.useFakeTimers();
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      mockModules.mockRunAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
        options.onSessionCreated(session);
        throw new Error("debug injected: content was flagged");
      });
      manager.armDebugFault("output_blocked");

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      await manager.getRecord(id)!.execution.promise;
      await vi.advanceTimersByTimeAsync(4_000);

      expect(manager.pauseRecoveryExpiry(id)).toBe(true);
      expect(manager.debugDiagnostics().agents[0]).toMatchObject({
        debugFaultKind: "output_blocked",
        recoveryPaused: true,
        recoveryRemainingMs: 6_000,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(manager.getRecord(id)).toBeDefined();
      expect(manager.debugDiagnostics().agents[0].recoveryRemainingMs).toBe(6_000);

      expect(manager.resumeRecoveryExpiry(id)).toBe(true);
      expect(manager.debugDiagnostics().agents[0].recoveryPaused).toBe(false);
      await vi.advanceTimersByTimeAsync(5_999);
      expect(manager.getRecord(id)).toBeDefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.getRecord(id)).toBeUndefined();
    });

    it("keeps recovery paused until both view and pin pauses are released", async () => {
      vi.useFakeTimers();
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      mockModules.mockRunAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
        options.onSessionCreated(session);
        throw new Error("debug injected: content was flagged");
      });
      manager.armDebugFault("output_blocked");

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      await manager.getRecord(id)!.execution.promise;
      await vi.advanceTimersByTimeAsync(4_000);

      expect(manager.togglePinned(id)).toBe(true);
      expect(manager.pauseRecoveryExpiry(id)).toBe(true);
      expect(manager.togglePinned(id)).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(manager.getRecord(id)).toBeDefined();
      expect(manager.debugDiagnostics().agents[0].recoveryRemainingMs).toBe(6_000);

      expect(manager.resumeRecoveryExpiry(id)).toBe(true);
      await vi.advanceTimersByTimeAsync(5_999);
      expect(manager.getRecord(id)).toBeDefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.getRecord(id)).toBeUndefined();
    });

    it("cancels a fault-bound expiry when the user continues the session", async () => {
      vi.useFakeTimers();
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      mockModules.mockRunAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
        options.onSessionCreated(session);
        throw new Error("debug injected: content was flagged");
      });
      const continuation = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(continuation.promise);
      manager.armDebugFault("output_blocked");

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;
      await expect(manager.interact(id, "Provide a defensive-only summary")).resolves.toEqual({ accepted: true });
      expect(record.execution.recoveryTtlMs).toBeUndefined();
      expect(record.execution.debugFaultKind).toBe("output_blocked");

      await vi.advanceTimersByTimeAsync(10_000);
      expect(manager.getRecord(id)).toBe(record);
      expect(record.lifecycle.status).toBe("running");

      continuation.resolve({ responseText: "defensive summary", aborted: false, turnLimited: false });
      await record.execution.promise;
      expect(record.lifecycle.status).toBe("completed");
    });

    it("uses the normal recovery window for a real failure after continuation", async () => {
      vi.useFakeTimers();
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      mockModules.mockRunAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
        options.onSessionCreated(session);
        throw new Error("debug injected: content was flagged");
      });
      mockModules.mockContinueAgentSession.mockRejectedValue(new Error("provider internal error"));
      manager.armDebugFault("output_blocked");

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      await expect(manager.interact(id, "continue")).resolves.toEqual({ accepted: true });
      await record.execution.promise;
      expect(record.lifecycle.status).toBe("error");
      expect(record.execution.debugFaultKind).toBe("output_blocked");
      expect(record.execution.recoveryTtlMs).toBeUndefined();

      await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
      expect(manager.getRecord(id)).toBe(record);
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.getRecord(id)).toBeUndefined();
    });

    it("evicts old setup failures without a child session", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockRejectedValue(new Error("model unavailable"));

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;
      record.lifecycle.resultConsumed = true;
      record.lifecycle.completedAt = Date.now() - 20 * 60_000;

      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeUndefined();
    });

    it("does not evict records younger than the cutoff", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      const record = manager.getRecord(id)!;
      await record.execution.promise;
      record.lifecycle.resultConsumed = true;
      // Just completed — well within the 10-minute retention window.
      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeDefined();
    });
  });

  // ── Child session teardown ──

  describe("session teardown", () => {
    /**
     * Subagents load their own extension instances, so the parent's
     * session_shutdown never reaches them. Without an explicit emit here,
     * extensions holding session-scoped resources leak on every removal.
     */
    it("emits session_shutdown before disposing a cleared agent's session", async () => {
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      await manager.getRecord(id)!.execution.promise;

      expect(manager.clear(id)).toBe(true);
      await manager.dispose();

      expect(shutdownEvents(session)).toEqual([{ type: "session_shutdown", reason: "quit" }]);
      expect(session.dispose).toHaveBeenCalledTimes(1);
      expect(session.extensionRunner.emit.mock.invocationCallOrder[0])
        .toBeLessThan(session.dispose.mock.invocationCallOrder[0]);
    });

    it("emits session_shutdown when a stale record is evicted by cleanup", async () => {
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      const record = manager.getRecord(id)!;
      await record.execution.promise;
      record.lifecycle.resultConsumed = true;
      record.lifecycle.completedAt = Date.now() - 20 * 60_000;

      (manager as any).cleanup();
      await manager.dispose();

      expect(shutdownEvents(session)).toHaveLength(1);
      expect(session.dispose).toHaveBeenCalledTimes(1);
    });

    it("awaits every child shutdown before dispose() resolves", async () => {
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      const emitted = makeResolvablePromise();
      let shutdownFinished = false;
      session.extensionRunner.emit.mockImplementation(async () => {
        await emitted.promise;
        shutdownFinished = true;
      });
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      await manager.getRecord(id)!.execution.promise;

      const disposed = manager.dispose();
      expect(shutdownFinished).toBe(false);

      emitted.resolve(undefined);
      await disposed;

      expect(shutdownFinished).toBe(true);
      expect(session.dispose).toHaveBeenCalledTimes(1);
    });

    it("still disposes the session when a shutdown handler throws", async () => {
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      session.extensionRunner.emit.mockRejectedValue(new Error("handler exploded"));
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      await manager.getRecord(id)!.execution.promise;

      manager.clear(id);
      await expect(manager.dispose()).resolves.toBeUndefined();

      expect(session.dispose).toHaveBeenCalledTimes(1);
    });

    it("allows a slow valid shutdown handler to finish within 15 seconds", async () => {
      vi.useFakeTimers();
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      session.extensionRunner.emit.mockImplementation(
        () => new Promise<void>(resolve => setTimeout(resolve, 7_000)),
      );
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      await manager.getRecord(id)!.execution.promise;

      const disposed = manager.dispose();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(session.dispose).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4_000);
      await disposed;
      expect(session.dispose).toHaveBeenCalledTimes(1);
    });

    /**
     * emit() awaits handlers serially without a timeout. If a child extension handler hangs,
     * parent shutdown would block forever in dispose() unless the caller bounds the wait.
     */
    it("disposes the session and releases dispose() after a shutdown handler timeout", async () => {
      vi.useFakeTimers();
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      // Handler that never resolves.
      session.extensionRunner.emit.mockReturnValue(new Promise(() => {}));
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      await manager.getRecord(id)!.execution.promise;

      let disposeSettled = false;
      const disposed = manager.dispose().then(() => { disposeSettled = true; });

      await vi.advanceTimersByTimeAsync(0);
      expect(disposeSettled).toBe(false);
      expect(session.dispose).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(15_000);
      await disposed;

      expect(disposeSettled).toBe(true);
      expect(session.dispose).toHaveBeenCalledTimes(1);
    });

    /**
     * Extension instances inside child sessions rely on isInsideSubagentSpawn() in index.ts
     * to skip session_shutdown registration. If that invariant breaks, a child handler can
     * recurse into the parent manager's dispose() while it is awaiting the same emit,
     * causing a deadlock without the reentrancy guard.
     */
    it("avoids deadlock when a shutdown handler calls dispose() recursively", async () => {
      // Fake timers suppress the 15-second fallback so this test isolates the reentrancy guard.
      vi.useFakeTimers();
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      let reentrantSettled = false;
      session.extensionRunner.emit.mockImplementation(async () => {
        // Yield once so closeSession stores its own done promise in closing; a reentrant
        // dispose() would then await the promise driven by this same emit.
        await Promise.resolve();
        // Simulate a child extension calling back into the parent manager during shutdown.
        await manager.dispose();
        reentrantSettled = true;
      });
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
      await manager.getRecord(id)!.execution.promise;

      await manager.dispose();

      expect(reentrantSettled).toBe(true);
      expect(shutdownEvents(session)).toHaveLength(1);
      expect(session.dispose).toHaveBeenCalledTimes(1);
    });
  });

}); // end describe AgentManager
