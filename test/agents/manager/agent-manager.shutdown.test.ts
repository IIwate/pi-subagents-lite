import { mockAgentSession, mockRunResult, shutdownEvents, fakeOptions, disposeManager } from "./manager-test-helpers.js";
import { createTestHarness, type TestHarness } from "../../harness.js";
import type { AgentRecord } from "../../../src/types.js";
/**
 * agent-manager.shutdown.test.ts — Subagent teardown, disposal timeout, and stats notification tests.
 *
 * Covers:
 *   - Subagent session_shutdown event emissions before disposal
 *   - Disposal bounds (15-second timeout for hanging child shutdown handlers)
 *   - Reentrancy deadlock prevention
 *   - Stats update notification on runner usage callbacks
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCtx, fakePi, makeResolvablePromise } from "../../fixtures.js";
import { AgentManager } from "../../../src/agents/agent-manager.js";


const mockModules = vi.hoisted(() => ({
  mockRunAgent: vi.fn(),
  mockContinueAgentSession: vi.fn(),
}));

vi.mock("../../../src/agents/agent-runner.js", () => ({
  runAgent: mockModules.mockRunAgent,
  continueAgentSession: mockModules.mockContinueAgentSession,
}));

describe("AgentManager — Shutdown & Teardown", () => {
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

  it("emits session_shutdown before disposing a cleared agent's session", async () => {
    manager = new AgentManager(onComplete);
    const session = mockAgentSession();
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({ description: "task", modelKey: "test/model" }));
    await manager.getRecord(id)!.execution.promise;

    expect(manager.clear(id)).toBe(true);
    await manager.dispose();

    expect(shutdownEvents(session)).toEqual([{ type: "session_shutdown", reason: "quit" }]);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(session.abort.mock.invocationCallOrder[0])
      .toBeLessThan(session.extensionRunner.emit.mock.invocationCallOrder[0]);
    expect(session.extensionRunner.emit.mock.invocationCallOrder[0])
      .toBeLessThan(session.dispose.mock.invocationCallOrder[0]);
  });

  it("still completes teardown and disposes session when abort throws", async () => {
    manager = new AgentManager(onComplete);
    const session = mockAgentSession();
    session.abort = vi.fn().mockRejectedValue(new Error("abort failed"));
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({ description: "task", modelKey: "test/model" }));
    await manager.getRecord(id)!.execution.promise;

    manager.clear(id);
    await expect(manager.dispose()).resolves.toBeUndefined();

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the session and releases dispose() after a shutdown handler timeout", async () => {
    vi.useFakeTimers();
    manager = new AgentManager(onComplete);
    const session = mockAgentSession();
    session.extensionRunner.emit.mockReturnValue(new Promise(() => {}));
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({ description: "task", modelKey: "test/model" }));
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

  it("avoids deadlock when a shutdown handler calls dispose() recursively", async () => {
    vi.useFakeTimers();
    manager = new AgentManager(onComplete);
    const session = mockAgentSession();
    let reentrantSettled = false;
    session.extensionRunner.emit.mockImplementation(async () => {
      await Promise.resolve();
      await manager.dispose();
      reentrantSettled = true;
    });
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({ description: "task", modelKey: "test/model" }));
    await manager.getRecord(id)!.execution.promise;

    await manager.dispose();

    expect(reentrantSettled).toBe(true);
    expect(shutdownEvents(session)).toHaveLength(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("notifies stats update listener on tool use, usage, compaction, and turn end", async () => {
    manager = new AgentManager(onComplete);
    const onStatsUpdate = vi.fn();
    manager.setOnStatsUpdate(onStatsUpdate);

    const session = mockAgentSession();
    session.getSessionStats = vi.fn().mockReturnValue({ contextUsage: { percent: 12 } });
    const run = makeResolvablePromise();
    let capturedOptions: any;
    mockModules.mockRunAgent.mockImplementation((_ctx, _type, _prompt, options) => {
      capturedOptions = options;
      return run.promise;
    });

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({ description: "task", modelKey: "test/model" }));
    const record = manager.getRecord(id)!;
    await capturedOptions.onSessionCreated(session);

    capturedOptions.onToolUse();
    expect(record.stats.toolUses).toBe(1);
    expect(record.stats.contextPercent).toBe(12);
    expect(onStatsUpdate).toHaveBeenCalledTimes(1);
    expect(onStatsUpdate).toHaveBeenLastCalledWith(record);

    session.getSessionStats.mockReturnValue({ contextUsage: { percent: 23 } });
    capturedOptions.onAssistantUsage({ input: 100, output: 50, cacheWrite: 0, cost: 0.01 });
    expect(record.stats.lifetimeUsage.input).toBe(100);
    expect(record.stats.contextPercent).toBe(23);
    expect(onStatsUpdate).toHaveBeenCalledTimes(2);

    session.getSessionStats.mockReturnValue({ contextUsage: { percent: null } });
    capturedOptions.onCompaction();
    expect(record.stats.compactionCount).toBe(1);
    expect(record.stats.contextPercent).toBeNull();
    expect(onStatsUpdate).toHaveBeenCalledTimes(3);

    session.getSessionStats.mockReturnValue({ contextUsage: { percent: 34 } });
    capturedOptions.onTurnEnd(3);
    expect(record.stats.turnCount).toBe(3);
    expect(record.stats.contextPercent).toBe(34);
    expect(onStatsUpdate).toHaveBeenCalledTimes(4);

    run.resolve(mockRunResult({ session }));
    await record.execution.promise;
  });

  it("aborts a running setup before disposing the manager", async () => {
    const deferred = makeResolvablePromise();
    let signal: AbortSignal | undefined;
    mockModules.mockRunAgent.mockImplementationOnce((_ctx: any, _type: string, _prompt: string, options: any) => {
      signal = options.signal;
      return deferred.promise;
    });

    manager = new AgentManager(onComplete);
    manager.spawn(fakePi(), fakeCtx(), "general-purpose", "running", fakeOptions({
      description: "running",
      modelKey: "test/model",
    }));

    await manager.dispose();
    expect(signal?.aborted).toBe(true);
    deferred.resolve(mockRunResult());
  });

  it.each(["stopped", "error"] as const)("closes a late session after a run is %s without forwarding pending input", async status => {
    const ready = makeResolvablePromise();
    const completion = makeResolvablePromise();
    const session = mockAgentSession();
    let onSessionCreated: (session: any) => Promise<void>;
    mockModules.mockRunAgent.mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
      onSessionCreated = options.onSessionCreated;
      ready.resolve(undefined);
      await completion.promise;
      if (status === "error") throw new Error("setup failed");
      return mockRunResult({ session, aborted: true });
    });
    manager = new AgentManager(onComplete);
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "Late setup", fakeOptions());
    await ready.promise;
    expect(await manager.interact(id, "Pending input")).toEqual({ accepted: true });
    if (status === "stopped") {
      manager.abort(id, "user");
      await onSessionCreated!(session);
    }
    completion.resolve(undefined);
    await manager.getRecord(id)!.execution.promise;
    if (status === "error") await onSessionCreated!(session);
    expect(session.steer).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(manager.getRecord(id)!.lifecycle.status).toBe(status);
  });

  it("stops waiting when child session setup never settles", async () => {
    vi.useFakeTimers();
    mockModules.mockRunAgent.mockImplementationOnce(async (_ctx: any, _type: string, _prompt: string, options: any) => {
      options.onSessionSetupStarted();
      await new Promise(() => {});
      return mockRunResult();
    });

    manager = new AgentManager(onComplete);
    manager.spawn(fakePi(), fakeCtx(), "general-purpose", "stuck setup", fakeOptions({
      description: "stuck setup",
      modelKey: "test/model",
    }));

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
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "late setup", fakeOptions({
      description: "late setup",
      modelKey: "test/model",
    }));
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
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "cleared setup", fakeOptions({
      description: "cleared setup",
      modelKey: "test/model",
    }));
    const run = manager.getRecord(id)!.execution.promise!;

    expect(manager.clear(id)).toBe(true);
    setup.resolve(undefined);
    await run;

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("aborts in-flight session and settles before disposing a cleared running agent", async () => {
      manager = new AgentManager(onComplete);
      let streamSettled = false;
      let disposedWhileActive = false;

      const runResolvable = makeResolvablePromise();
      const session = mockAgentSession();
      session.isStreaming = true;
      session.abort = vi.fn().mockImplementation(async () => {
        // Simulate abort settling the run
        runResolvable.resolve({ responseText: "done", session, aborted: true, turnLimited: false });
      });
      session.dispose = vi.fn().mockImplementation(() => {
        if (!streamSettled) disposedWhileActive = true;
      });

      mockModules.mockRunAgent.mockImplementation(async (_ctx, _type, _prompt, options) => {
        await options.onSessionCreated(session);
        const res = await runResolvable.promise;
        streamSettled = true;
        return res;
      });

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({ description: "task", modelKey: "test/model" }));
      await Promise.resolve();

      expect(manager.getRecord(id)?.lifecycle.status).toBe("running");

      manager.clear(id);
      await manager.dispose();

      expect(session.abort).toHaveBeenCalledTimes(1);
      expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
      expect(session.dispose).toHaveBeenCalledTimes(1);
      expect(session.abort.mock.invocationCallOrder[0])
        .toBeLessThan(session.extensionRunner.emit.mock.invocationCallOrder[0]);
      expect(session.extensionRunner.emit.mock.invocationCallOrder[0])
        .toBeLessThan(session.dispose.mock.invocationCallOrder[0]);
      expect(disposedWhileActive).toBe(false);
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

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({ description: "task", modelKey: "test/model" }));
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

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({ description: "task", modelKey: "test/model" }));
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

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", fakeOptions({ description: "task", modelKey: "test/model" }));
      await manager.getRecord(id)!.execution.promise;

      const disposed = manager.dispose();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(session.dispose).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4_000);
      await disposed;
      expect(session.dispose).toHaveBeenCalledTimes(1);
    });
});
