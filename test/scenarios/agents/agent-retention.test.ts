import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../../../src/agents/agent-manager.js";
import { SpawnCoordinator } from "../../../src/spawn/spawn-coordinator.js";
import { setCoordinator, setManager, setPiInstance, setSessionCtx, takeFallbackResults } from "../../../src/shell.js";
import { createTestHarness, type TestHarness } from "../../support/harness.js";
import { fakeCtx, fakePi, makeResolvablePromise } from "../../support/fixtures.js";
import { disposeManager, fakeOptions, mockAgentSession, mockRunResult, shutdownEvents } from "../../support/manager.js";

const runner = vi.hoisted(() => ({ runAgent: vi.fn(), continueAgentSession: vi.fn() }));
vi.mock("../../../src/agents/agent-runner.js", () => runner);

describe("AgentManager retention", () => {
  let harness: TestHarness;
  let manager: AgentManager;
  let coordinator: SpawnCoordinator;
  let ctx: ReturnType<typeof fakeCtx>;
  let pi: ReturnType<typeof fakePi>;

  beforeEach(() => {
    harness = createTestHarness();
    vi.useFakeTimers();
    runner.runAgent.mockReset().mockImplementation(async () => mockRunResult());
    runner.continueAgentSession.mockReset();
    const parent = SessionManager.inMemory();
    ctx = { ...fakeCtx(), sessionManager: parent, isIdle: () => false };
    pi = { ...fakePi(), sendMessage: vi.fn(),
      appendEntry: vi.fn((type: string, data: unknown) => parent.appendCustomEntry(type, data)) };
    setSessionCtx(ctx);
    setPiInstance(pi);
    manager = new AgentManager(record => coordinator.onAgentComplete(record));
    setManager(manager);
    coordinator = new SpawnCoordinator(manager);
    setCoordinator(coordinator);
    harness.onDispose(async () => {
      await disposeManager(manager);
      await coordinator.reconcileDeliveryState();
      coordinator.dispose();
      takeFallbackResults(parent.getSessionId());
      setCoordinator(null);
      setManager(null);
      setSessionCtx(null!);
      setPiInstance(null!);
    });
  });
  afterEach(async () => { await harness.dispose(); });

  async function spawn(runInBackground = false) {
    const { record } = await coordinator.spawn(pi, ctx, {
      ...fakeOptions(), type: "general-purpose", prompt: "Task", runInBackground, graceTurns: 6,
    });
    await record.execution.promise;
    return record;
  }

  it("retains unconsumed results beyond the cleanup window", async () => {
    const id = manager.spawn(pi, ctx, "general-purpose", "Task", fakeOptions());
    await manager.getRecord(id)!.execution.promise;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(manager.getRecord(id)?.result).toBe("done");
  });

  it.each([false, true])("evicts a consumed or persisted result only after its full retention window: background=%s", async background => {
    const onRemove = vi.fn();
    manager.setOnRemove(onRemove);
    const record = await spawn(background);
    const session = record.execution.session;
    expect(background ? record.lifecycle.resultPersisted : record.lifecycle.resultConsumed).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(manager.getRecord(record.id)).toBe(record);
    expect(onRemove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.getRecord(record.id)).toBeUndefined();
    expect(onRemove).toHaveBeenCalledOnce();
    expect(shutdownEvents(session)).toEqual([{ type: "session_shutdown", reason: "quit" }]);
    expect(session!.dispose).toHaveBeenCalledOnce();
  });

  it("evicts an observed setup failure without a child session", async () => {
    runner.runAgent.mockRejectedValueOnce(new Error("setup failed"));
    const record = await spawn();
    expect(record.lifecycle.status).toBe("error");
    expect(record.execution.session).toBeUndefined();
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(manager.getRecord(record.id)).toBeUndefined();
  });

  it.each([false, true])("retains a live-session error for the ordinary window: background=%s", async background => {
    const session = mockAgentSession();
    runner.runAgent.mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
      await options.onSessionCreated(session);
      throw new Error("content was flagged");
    });
    const record = await spawn(background);
    expect(record).toMatchObject({ lifecycle: { status: "error" }, execution: { session } });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(manager.getRecord(record.id)).toBe(record);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.getRecord(record.id)).toBeUndefined();
  });

  it("pins completed records independently and resumes their remaining window", async () => {
    const first = await spawn();
    const second = await spawn();
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(manager.togglePinned(first.id)).toBe(true);
    expect(manager.togglePinned(second.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(manager.getRecord(first.id)).toBe(first);
    expect(manager.getRecord(second.id)).toBe(second);
    expect(manager.togglePinned(first.id)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.getRecord(first.id)).toBe(first);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.getRecord(first.id)).toBeUndefined();
    expect(manager.getRecord(second.id)).toBe(second);
    expect(manager.clear(second.id)).toBe(true);
    expect(manager.getRecord(second.id)).toBeUndefined();
  });

  it("starts a full retention window after a run pinned before completion is unpinned", async () => {
    const completion = makeResolvablePromise();
    runner.runAgent.mockReturnValueOnce(completion.promise);
    const foreground = spawn();
    const record = manager.listAgents()[0];
    expect(manager.togglePinned(record.id)).toBe(true);
    completion.resolve(mockRunResult());
    await foreground;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(manager.getRecord(record.id)).toBe(record);
    expect(manager.togglePinned(record.id)).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(manager.getRecord(record.id)).toBe(record);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.getRecord(record.id)).toBeUndefined();
  });

  it("applies retention after an observed continuation error is unpinned", async () => {
    const record = await spawn();
    runner.continueAgentSession.mockRejectedValueOnce(new Error("provider internal error"));
    expect(await manager.interact(record.id, "Continue")).toEqual({ accepted: true });
    await record.execution.promise;
    expect(record).toMatchObject({ lifecycle: { status: "error" }, error: "provider internal error" });
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(manager.getRecord(record.id)).toBe(record);
    expect(manager.togglePinned(record.id)).toBe(false);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(manager.getRecord(record.id)).toBeUndefined();
  });
});
