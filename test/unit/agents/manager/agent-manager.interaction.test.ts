import { mockAgentSession, mockRunResult, fakeOptions, disposeManager } from "../../../support/manager.js";
import { createTestHarness, type TestHarness } from "../../../support/harness.js";
import type { AgentRecord } from "../../../../src/types.js";
/**
 * agent-manager.interaction.test.ts — Interactive steering and session continuation tests.
 *
 * Covers:
 *   - Steering running subagents (with text and images)
 *   - Taking over sessions, setting pinnedAt, detaching from parent turns
 *   - Resuming settled sessions (successful and failed)
 *   - Concurrency re-checks on continuation
 *   - Rejections for queued and unsettled agents
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCtx, fakePi, makeResolvablePromise } from "../../../support/fixtures.js";
import { AgentManager } from "../../../../src/agents/agent-manager.js";


const mockModules = vi.hoisted(() => ({
  mockRunAgent: vi.fn(),
  mockContinueAgentSession: vi.fn(),
}));

vi.mock("../../../../src/agents/agent-runner.js", () => ({
  runAgent: mockModules.mockRunAgent,
  continueAgentSession: mockModules.mockContinueAgentSession,
}));

describe("AgentManager — Interaction", () => {
  let harness: TestHarness;
  let manager: AgentManager;
  let onComplete = vi.fn<(record: AgentRecord) => void>();

  beforeEach(() => {
    harness = createTestHarness();
    harness.onDispose(() => disposeManager(manager));
    mockModules.mockRunAgent.mockReset();
    mockModules.mockContinueAgentSession.mockReset();
    onComplete = vi.fn<(record: AgentRecord) => void>();
  });

  afterEach(async () => { await harness.dispose(); });

  it("steers a running agent", async () => {
    manager = new AgentManager(onComplete);
    const deferred = makeResolvablePromise();
    const session = mockAgentSession();
    mockModules.mockRunAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options.onSessionCreated(session);
      return deferred.promise;
    });

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({
      description: "task",
      modelKey: "test/model",
    }));
    await expect(manager.interact(id, "new direction")).resolves.toEqual({ accepted: true });
    expect(session.steer).toHaveBeenCalledWith("new direction", undefined);

    deferred.resolve(mockRunResult({ session }));
  });

  it("marks takeover and pins the first interaction without changing the pin on later messages", async () => {
    manager = new AgentManager(onComplete);
    const deferred = makeResolvablePromise();
    const session = mockAgentSession();
    mockModules.mockRunAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options.onSessionCreated(session);
      return deferred.promise;
    });

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({
      description: "task",
      modelKey: "test/model",
    }));
    const record = manager.getRecord(id)!;

    expect(record.lifecycle.pinnedAt).toBeUndefined();
    expect(record.lifecycle.takenOver).toBeUndefined();

    await manager.interact(id, "steer input");

    expect(record.lifecycle.takenOver).toBe(true);
    expect(typeof record.lifecycle.pinnedAt).toBe("number");

    const pinnedAt = record.lifecycle.pinnedAt;
    await manager.interact(id, "second steer");
    expect(record.lifecycle.pinnedAt).toBe(pinnedAt);

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

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({
      description: "task",
      modelKey: "test/model",
    }));
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

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({
      description: "task",
      modelKey: "test/model",
    }));
    const record = manager.getRecord(id)!;
    await record.execution.promise;

    expect(record.lifecycle.status).toBe("error");
    await expect(manager.interact(id, "Provide a defensive-only summary")).resolves.toEqual({ accepted: true });
    expect(record.lifecycle.status).toBe("running");

    continuation.resolve({ responseText: "defensive summary", aborted: false, turnLimited: false });
    await record.execution.promise;

    expect(record.lifecycle.status).toBe("completed");
    expect(record.result).toBe("defensive summary");
  });

  it("respects model concurrency when resuming a settled agent", async () => {
    manager = new AgentManager(onComplete, {
      default: 1,
      models: { "test/model": 1 },
    });
    const firstSession = mockAgentSession();
    mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult({ session: firstSession }));

    const firstId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", fakeOptions({
      description: "first",
      modelKey: "test/model",
    }));
    await manager.getRecord(firstId)!.execution.promise;

    const secondDeferred = makeResolvablePromise();
    const secondSession = mockAgentSession();
    mockModules.mockRunAgent.mockReturnValueOnce(secondDeferred.promise);
    manager.spawn(fakePi(), fakeCtx(), "general-purpose", "second", fakeOptions({
      description: "second",
      modelKey: "test/model",
    }));

    await expect(manager.interact(firstId, "resume")).resolves.toEqual({
      accepted: false,
      reason: "concurrency",
      modelKey: "test/model",
    });
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

    manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", fakeOptions({
      description: "first",
      modelKey: "test/model",
    }));
    const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "second", fakeOptions({
      description: "second",
      modelKey: "test/model",
    }));

    await expect(manager.interact(queuedId, "hello")).resolves.toEqual({ accepted: false, reason: "queued" });
    deferred.resolve(mockRunResult());
  });

  it("forwards images when steering a running agent", async () => {
      manager = new AgentManager(onComplete);
      const deferred = makeResolvablePromise();
      const session = mockAgentSession();
      mockModules.mockRunAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
        await options.onSessionCreated(session);
        return deferred.promise;
      });
      const images = [{ type: "image", data: "abc", mimeType: "image/png" }] as any;

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({
        description: "task",
        modelKey: "test/model",
      }));

      await expect(manager.interact(id, "inspect this", images)).resolves.toEqual({ accepted: true });
      expect(session.steer).toHaveBeenCalledWith("inspect this", images);

      deferred.resolve(mockRunResult({ session }));
    });

  it("handles abort rejection while stopping a resumed session", async () => {
      manager = new AgentManager(onComplete);
      const session = mockAgentSession();
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));
      const continuation = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(continuation.promise);

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({
        description: "task",
        modelKey: "test/model",
      }));
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

  it("rejects a stopped agent until its previous execution settles", async () => {
      manager = new AgentManager(onComplete);
      const deferred = makeResolvablePromise();
      const session = mockAgentSession();
      mockModules.mockRunAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
        await options.onSessionCreated(session);
        return deferred.promise;
      });

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({
        description: "task",
        modelKey: "test/model",
      }));
      manager.abort(id, "user");

      await expect(manager.interact(id, "resume too early")).resolves.toEqual({ accepted: false, reason: "unavailable" });
      expect(mockModules.mockContinueAgentSession).not.toHaveBeenCalled();

      deferred.resolve(mockRunResult({ session, aborted: true }));
    });

  it("keeps a settled error when concurrency rejects continuation", async () => {
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

      const failedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "failed", fakeOptions({
        description: "failed",
        modelKey: "test/model",
      }));
      const failedRecord = manager.getRecord(failedId)!;
      await failedRecord.execution.promise;

      const blocker = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(blocker.promise);
      const blockerId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "blocker", fakeOptions({
        description: "blocker",
        modelKey: "test/model",
      }));

      await expect(manager.interact(failedId, "continue")).resolves.toEqual({
        accepted: false,
        reason: "concurrency",
        modelKey: "test/model",
      });
      expect(failedRecord.lifecycle.status).toBe("error");
      expect(failedRecord.error).toBe("debug injected: content was flagged");
      expect(manager.getRecord(failedId)).toBe(failedRecord);

      blocker.resolve(mockRunResult());
      await manager.getRecord(blockerId)!.execution.promise;
    });

  it("continues a delivered Debug error as a new terminal result", async () => {
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

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({
        description: "task",
        modelKey: "test/model",
      }));
      const record = manager.getRecord(id)!;
      await record.execution.promise;
      await expect(manager.interact(id, "Provide a defensive-only summary")).resolves.toEqual({ accepted: true });
      expect(record.execution.debugFaultKind).toBe("output_blocked");
      expect(record.lifecycle.status).toBe("running");
      expect(onComplete).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(manager.getRecord(id)).toBe(record);
      expect(record.lifecycle.status).toBe("running");

      continuation.resolve({ responseText: "defensive summary", aborted: false, turnLimited: false });
      await record.execution.promise;
      expect(record.lifecycle.status).toBe("completed");
      expect(onComplete).toHaveBeenCalledTimes(2);
    });

  it("notifies stats update listener during interact continuation", async () => {
      manager = new AgentManager(onComplete);
      const onStatsUpdate = vi.fn();
      manager.setOnStatsUpdate(onStatsUpdate);

      const session = mockAgentSession();
      session.getSessionStats = vi.fn().mockReturnValue({ contextUsage: { percent: 10 } });
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));

      const continuation = makeResolvablePromise();
      let continueOptions: any;
      mockModules.mockContinueAgentSession.mockImplementation((_session, _prompt, options) => {
        continueOptions = options;
        return continuation.promise;
      });

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({ description: "task", modelKey: "test/model" }));
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      onStatsUpdate.mockClear();
      session.getSessionStats.mockClear();

      await manager.interact(id, "continue");
      session.getSessionStats.mockReturnValue({ contextUsage: { percent: 45 } });
      continueOptions.onToolUse();
      expect(record.stats.toolUses).toBe(1);
      expect(record.stats.contextPercent).toBe(45);
      expect(onStatsUpdate).toHaveBeenCalledTimes(1);
      expect(onStatsUpdate).toHaveBeenLastCalledWith(record);

      session.getSessionStats.mockReturnValue({ contextUsage: { percent: 56 } });
      continueOptions.onTurnEnd(2);
      expect(record.stats.turnCount).toBe(3);
      expect(record.stats.contextPercent).toBe(56);
      expect(onStatsUpdate).toHaveBeenCalledTimes(2);
      expect(onStatsUpdate).toHaveBeenLastCalledWith(record);
      expect(session.getSessionStats).toHaveBeenCalledTimes(2);

      continuation.resolve({ responseText: "cont", aborted: false, turnLimited: false });
      await record.execution.promise;
    });

    it("cancels active retry via abortRetry when session is retrying", async () => {
      manager = new AgentManager(onComplete);
      const session = mockAgentSession() as any;
      session.isRetrying = true;
      session.abortRetry = vi.fn();
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
        await options.onSessionCreated(session);
        return deferred.promise;
      });

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({ description: "task", modelKey: "test/model" }));
      const record = manager.getRecord(id)!;
      record.execution.retryState = {
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        startAt: Date.now(),
      };

      const aborted = manager.abortRetry(id);
      expect(aborted).toBe(true);
      expect(session.abortRetry).toHaveBeenCalledOnce();
      expect(record.execution.retryState).toBeUndefined();

      deferred.resolve(mockRunResult({ session }));
    });

    it("returns false from abortRetry when agent is not retrying", async () => {
      manager = new AgentManager(onComplete);
      const session = mockAgentSession() as any;
      session.isRetrying = false;
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
        await options.onSessionCreated(session);
        return deferred.promise;
      });

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({ description: "task", modelKey: "test/model" }));

      expect(manager.abortRetry(id)).toBe(false);

      deferred.resolve(mockRunResult({ session }));
    });

    it("tracks auto_retry_start and auto_retry_end events on the record", async () => {
      manager = new AgentManager(onComplete);
      let sessionListener: ((event: any) => void) | undefined;
      const session = mockAgentSession() as any;
      session.subscribe = vi.fn((fn: any) => {
        sessionListener = fn;
        return vi.fn();
      });
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
        await options.onSessionCreated(session);
        return deferred.promise;
      });

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({ description: "task", modelKey: "test/model" }));
      const record = manager.getRecord(id)!;
      expect(record.execution.retryState).toBeUndefined();

      sessionListener?.({
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 4,
        delayMs: 4000,
        errorMessage: "stream timeout",
      });
      expect(record.execution.retryState).toEqual(expect.objectContaining({
        attempt: 2,
        maxAttempts: 4,
        delayMs: 4000,
        errorMessage: "stream timeout",
      }));

      sessionListener?.({
        type: "auto_retry_end",
        success: true,
        attempt: 2,
      });
      expect(record.execution.retryState).toBeUndefined();

      deferred.resolve(mockRunResult({ session }));
    });
});
