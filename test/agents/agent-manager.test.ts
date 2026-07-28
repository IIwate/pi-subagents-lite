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

    it("per-model limit overrides per-provider limit", () => {
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
    });
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
    });

    it("rejects a normal completion without final assistant text", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ responseText: "" }));

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      expect(record.lifecycle.status).toBe("error");
      expect(record.error).toBe("Subagent completed without final assistant text");
      expect(record.result).toBeUndefined();
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

      await expect(manager.interact(id, "new direction")).resolves.toBe(true);
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

      await expect(manager.interact(id, "inspect this", images)).resolves.toBe(true);
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

      await expect(manager.interact(id, "continue")).resolves.toBe(true);
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

      await expect(manager.interact(id, "continue")).resolves.toBe(true);
      expect(manager.abort(id, "user")).toBe(true);
      expect(session.abort).toHaveBeenCalled();
      expect(abortCatch).toHaveBeenCalled();

      continuation.resolve({ responseText: "", aborted: true, turnLimited: false });
      await record.execution.promise;
      expect(record.lifecycle.status).toBe("stopped");
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

      await expect(manager.interact(id, "resume too early")).resolves.toBe(false);
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

      await expect(manager.interact(firstId, "resume")).resolves.toBe(false);
      expect(mockModules.mockContinueAgentSession).not.toHaveBeenCalled();

      secondDeferred.resolve(mockRunResult({ session: secondSession }));
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

      await expect(manager.interact(queuedId, "hello")).resolves.toBe(false);
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
