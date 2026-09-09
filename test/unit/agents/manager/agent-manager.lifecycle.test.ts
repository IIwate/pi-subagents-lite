import { mockAgentSession, mockRunResult, fakeOptions, disposeManager } from "../../../support/manager.js";
import { createTestHarness, type TestHarness } from "../../../support/harness.js";
import type { AgentRecord } from "../../../../src/types.js";
/**
 * agent-manager.lifecycle.test.ts — Agent execution lifecycle tests.
 *
 * Covers:
 *   - Start, completion, provider error recording
 *   - Cancellation and abort propagation from parent signals
 *   - Settling of queued and running agents on stop
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

describe("AgentManager — Lifecycle & Completion", () => {
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

  it("records provider failures instead of completing with an empty result", async () => {
    manager = new AgentManager(onComplete);
    mockModules.mockRunAgent.mockRejectedValue(new Error("503 service_unavailable"));

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({
      description: "task",
      modelKey: "test/model",
    }));
    const record = manager.getRecord(id)!;
    await record.execution.promise;

    expect(record.lifecycle.status).toBe("error");
    expect(record.error).toBe("503 service_unavailable");
    expect(record.result).toBeUndefined();
    expect(onComplete).toHaveBeenCalledWith(record);
  });

  it("records a missing worktree failure without rejecting the parent spawn", async () => {
    manager = new AgentManager(onComplete);
    mockModules.mockRunAgent.mockRejectedValue(new Error("ENOENT: working directory was removed"));

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({
      worktreePath: "/deleted/worktree",
    }));
    const record = manager.getRecord(id)!;
    await record.execution.promise;

    expect(record.lifecycle.status).toBe("error");
    expect(record.error).toContain("ENOENT");
    expect(onComplete).toHaveBeenCalledWith(record);
  });

  it("notifies a live provider failure immediately and only once", async () => {
    vi.useFakeTimers();
    manager = new AgentManager(onComplete);
    const session = mockAgentSession();
    mockModules.mockRunAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated(session);
      throw new Error("stream_read_error: response closed");
    });

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({
      description: "task",
      modelKey: "test/model",
    }));
    const record = manager.getRecord(id)!;
    await record.execution.promise;

    expect(record).toMatchObject({
      lifecycle: { status: "error" },
      execution: { settled: true, session },
      error: "stream_read_error: response closed",
    });
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(record);

    await vi.advanceTimersByTimeAsync(31 * 60_000);

    expect(onComplete).toHaveBeenCalledOnce();
    expect(record.error).toBe("stream_read_error: response closed");
  });

  it("settles a foreground wait when a queued agent is stopped", async () => {
    manager = new AgentManager(onComplete, {
      default: 1,
      models: { "test/model": 1 },
    });
    const blocker = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(blocker.promise);

    const blockerId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "blocker", fakeOptions({
      description: "blocker",
      modelKey: "test/model",
    }));
    const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "queued", fakeOptions({
      description: "queued",
      modelKey: "test/model",
    }));
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

    const firstId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", fakeOptions({
      description: "first",
      signal: controller.signal,
    }));
    const secondId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "second", fakeOptions({
      description: "second",
      signal: controller.signal,
    }));
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

    const blockerId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "blocker", fakeOptions({
      description: "blocker",
      modelKey: "test/model",
    }));
    const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "queued", fakeOptions({
      description: "queued",
      modelKey: "test/model",
      signal: controller.signal,
    }));
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

  it("does not start an agent whose parent signal is already aborted", () => {
    manager = new AgentManager(onComplete);
    const controller = new AbortController();
    controller.abort();

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "cancelled", fakeOptions({
      description: "cancelled",
      signal: controller.signal,
    }));

    expect(manager.getRecord(id)).toMatchObject({
      lifecycle: { status: "stopped", stoppedBy: "user" },
      execution: { settled: true },
    });
    expect(mockModules.mockRunAgent).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(manager.getRecord(id));
  });

  it("returns a shutdown error when a queued foreground agent is disposed", async () => {
    manager = new AgentManager(onComplete, {
      default: 1,
      models: { "test/model": 1 },
    });
    const blocker = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(blocker.promise);

    const blockerId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "blocker", fakeOptions({
      description: "blocker",
      modelKey: "test/model",
    }));
    const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "queued", fakeOptions({
      description: "queued",
      modelKey: "test/model",
    }));
    const queuedRecord = manager.getRecord(queuedId)!;
    const queuedWait = queuedRecord.execution.promise!;

    await manager.dispose();
    await queuedWait;

    expect(queuedRecord.lifecycle.status).toBe("error");
    expect(queuedRecord.error).toContain("manager disposed");
    blocker.resolve(mockRunResult());
    await manager.getRecord(blockerId)?.execution.promise;
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

    const firstId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", fakeOptions({
      description: "first",
      modelKey: "test/model",
      signal: controller.signal,
    }));
    const secondId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "second", fakeOptions({
      description: "second",
      modelKey: "test/model",
    }));

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

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "initial", fakeOptions({
      description: "initial",
      signal: controller.signal,
    }));
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
    const firstId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", fakeOptions({
      description: "first",
      modelKey: "test/model",
    }));
    await manager.getRecord(firstId)!.execution.promise;
    const secondId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "second", fakeOptions({
      description: "second",
      modelKey: "test/model",
    }));
    await manager.getRecord(secondId)!.execution.promise;

    expect(runOptions[0].debugFault).toBe("output_blocked");
    expect(runOptions[1].debugFault).toBeUndefined();
    expect(manager.getRecord(firstId)!.execution).toMatchObject({
      debugFaultKind: "output_blocked",
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

      const blockerId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "blocker", fakeOptions({
        description: "blocker",
        modelKey: "test/model",
      }));
      manager.armDebugFault("output_blocked");
      const firstQueuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first queued", fakeOptions({
        description: "first queued",
        modelKey: "test/model",
      }));
      const secondQueuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "second queued", fakeOptions({
        description: "second queued",
        modelKey: "test/model",
      }));

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

      const blockerId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "blocker", fakeOptions({
        description: "blocker",
        modelKey: "test/model",
      }));
      manager.armDebugFault("provider_error");
      const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "queued", fakeOptions({
        description: "queued",
        modelKey: "test/model",
      }));
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

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({
        description: "task",
        modelKey: "test/model",
      }));
      await manager.getRecord(id)!.execution.promise;

      expect(manager.getRecord(id)!.execution.debugFaultKind).toBeUndefined();
      expect(manager.debugDiagnostics().armedFault).toBeUndefined();
    });
});
