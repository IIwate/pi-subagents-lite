import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../../src/types.js";

vi.mock("../../src/agents/agent-types.js", () => ({
  resolveType: vi.fn((name: string) => name),
  getAgentConfig: vi.fn(() => undefined),
  discoverNewAgents: vi.fn(async () => 0),
}));

vi.mock("../../src/spawn/worktree-validator.js", () => ({
  validateWorktreePath: vi.fn(async () => ({ ok: true, resolvedPath: "/wt" })),
}));

vi.mock("../../src/utils.js", () => ({
  parseModelKey: vi.fn(() => null),
  parseThinkingLevel: vi.fn(() => undefined),
}));

vi.mock("../../src/config/config-io.js", () => ({
  loadConfig: vi.fn(() => ({ modelRouting: { enabled: false, enabledProviders: [], agentAccess: {} }, agent: { forceBackground: false }, concurrency: { default: 4 } })),
  saveConfigAtomic: vi.fn(),
  DEFAULT_CONFIG: { modelRouting: { enabled: false, enabledProviders: [], agentAccess: {} }, agent: { forceBackground: false }, concurrency: { default: 4 } },
}));

vi.mock("../../src/agents/tool-execution.js", () => ({
  formatResultContent: (record: AgentRecord) =>
    record.lifecycle.status === "error"
      ? `Agent failed: ${record.error || "unknown error"}`
      : record.result ?? "",
}));

const {
  mockPi,
  mockGetPiInstance,
  mockGetBranch,
  mockGetEntries,
  sessionEntries,
  activeBranchEntries,
  fallbackResults,
  fallbackMeta,
} = vi.hoisted(() => ({
  fallbackResults: [] as any[],
  fallbackMeta: {
    sessionId: undefined as string | undefined,
    currentSessionId: "test-session",
    currentLeafId: "origin-a" as string | null,
    idle: true,
  },
  mockPi: {
    sendMessage: vi.fn(),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      sessionEntries.push({ type: "custom", customType, data });
    }),
    sendUserMessage: vi.fn(),
    exec: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
  } as unknown as ExtensionAPI,
  mockGetPiInstance: vi.fn(() => null as unknown as ExtensionAPI),
  mockGetBranch: vi.fn(() => activeBranchEntries),
  mockGetEntries: vi.fn(() => sessionEntries),
  sessionEntries: [] as any[],
  activeBranchEntries: [{ id: "origin-a" }] as any[],
}));

vi.mock("../../src/shell.js", () => ({
  getPiInstance: () => mockGetPiInstance(),
  takeFallbackResults: (session: string) => {
    return session === fallbackMeta.sessionId ? fallbackResults.splice(0) : [];
  },
  setFallbackResults: (session: string, results: any[]) => {
    if (results.length === 0) {
      if (session === fallbackMeta.sessionId) fallbackResults.length = 0;
      return;
    }
    fallbackMeta.sessionId = session;
    fallbackResults.splice(0, fallbackResults.length, ...results);
  },
  getSessionCtx: () => ({
    isIdle: () => fallbackMeta.idle,
    sessionManager: {
      getBranch: mockGetBranch,
      getEntries: mockGetEntries,
      getLeafId: () => fallbackMeta.currentLeafId,
      getSessionId: () => fallbackMeta.currentSessionId,
    },
    ui: { notify: vi.fn() },
  }),
  getNavigator: () => null,
}));

function makeMockManager() {
  const records = new Map<string, any>();
  return {
    spawn: vi.fn((_pi: any, _ctx: any, type: string, _prompt: string, options: any) => {
      const id = `agent-${records.size}`;
      const record: any = {
        id,
        display: { type, description: options.description, invocation: options.invocation },
        lifecycle: { status: "running", startedAt: Date.now() },
        execution: {
          promise: Promise.resolve("done"),
          resultSessionId: options.resultSessionId,
          resultOriginEntryId: options.resultOriginEntryId,
          session: undefined,
        },
        stats: {
          lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
          toolUses: 0,
          turnCount: 1,
          maxTurns: options.maxTurns,
          compactionCount: 0,
        },
        result: "done",
      };
      records.set(id, record);
      return id;
    }),
    getRecord: vi.fn((id: string) => records.get(id)),
    listAgents: vi.fn(() => [...records.values()]),
    interact: vi.fn(async () => ({ accepted: true as const })),
    setRecord: (id: string, record: any) => records.set(id, record),
    deleteRecord: (id: string) => records.delete(id),
    dispose: vi.fn(),
  };
}

function makeMockCtx() {
  return {
    cwd: "/test",
    model: undefined,
    modelRegistry: {},
    sessionManager: {
      getLeafId: () => fallbackMeta.currentLeafId,
      getSessionId: () => fallbackMeta.currentSessionId,
    },
  } as unknown as ExtensionContext;
}

function complete(record: any, status = "completed", result = "result") {
  record.lifecycle.status = status;
  record.lifecycle.completedAt = Date.now();
  record.result = result;
}

describe("SpawnCoordinator", () => {
  let SpawnCoordinator: typeof import("../../src/spawn/spawn-coordinator.js").SpawnCoordinator;
  let manager: ReturnType<typeof makeMockManager>;
  let ctx: ExtensionContext;

  beforeEach(async () => {
    manager = makeMockManager();
    ctx = makeMockCtx();
    sessionEntries.length = 0;
    activeBranchEntries.splice(0, activeBranchEntries.length, { id: "origin-a" });
    fallbackResults.length = 0;
    fallbackMeta.sessionId = undefined;
    fallbackMeta.currentSessionId = "test-session";
    fallbackMeta.currentLeafId = "origin-a";
    fallbackMeta.idle = true;
    mockPi.sendMessage.mockReset();
    mockPi.appendEntry.mockReset();
    mockPi.appendEntry.mockImplementation((customType: string, data: unknown) => {
      sessionEntries.push({ type: "custom", customType, data });
    });
    mockGetBranch.mockClear();
    mockGetEntries.mockClear();
    mockGetPiInstance.mockReturnValue(mockPi);
    const mod = await import("../../src/spawn/spawn-coordinator.js");
    SpawnCoordinator = mod.SpawnCoordinator;
  });

  async function spawnBackground(coordinator: InstanceType<typeof SpawnCoordinator>) {
    return coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test spawn",
      graceTurns: 6,
      runInBackground: true,
    });
  }

  it("captures the parent delivery target only for background work", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);

    expect(result.record.execution).toMatchObject({
      resultSessionId: "test-session",
      resultOriginEntryId: "origin-a",
    });
    expect(result.record.execution).not.toHaveProperty("backgroundDelivery");
    expect(manager.spawn.mock.calls[0][4]).not.toHaveProperty("runInBackground");
    expect(manager.spawn.mock.calls[0][4]).not.toHaveProperty("backgroundDelivery");
  });

  it("awaits foreground work and marks its direct result consumed", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test foreground",
      graceTurns: 6,
      runInBackground: false,
    });

    expect(result.record.lifecycle.resultConsumed).toBe(true);
    expect(result.record.execution.resultSessionId).toBeUndefined();
    expect(result.record.execution).not.toHaveProperty("backgroundDelivery");
    expect(mockPi.sendMessage).not.toHaveBeenCalled();
  });

  it("marks an empty foreground result consumed", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const pending = coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test foreground",
      graceTurns: 6,
      runInBackground: false,
    });
    manager.listAgents()[0].result = "";

    const result = await pending;

    expect(result.record.lifecycle.resultConsumed).toBe(true);
  });

  it("persists a background result and requests one parent wake immediately", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    complete(result.record, "completed", "original result");

    coordinator.onAgentComplete(result.record);

    expect(mockPi.appendEntry).toHaveBeenCalledWith(
      "subagents-lite:pending-result",
      expect.objectContaining({ agentId: result.agentId, result: "original result", error: null }),
    );
    const persisted = mockPi.appendEntry.mock.calls.find(
      ([customType]) => customType === "subagents-lite:pending-result",
    )?.[1];
    expect(persisted).not.toHaveProperty("delivery");
    expect(mockPi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-result", content: expect.stringContaining("original result") }),
      { triggerTurn: true },
    );
    expect(mockPi.appendEntry.mock.invocationCallOrder[0])
      .toBeLessThan(mockPi.sendMessage.mock.invocationCallOrder[0]);
    expect(result.record.lifecycle.resultPersisted).toBe(true);
    expect(result.record.lifecycle.resultConsumed).toBeUndefined();
    expect(coordinator.pendingResultCount()).toBeUndefined();
  });

  it("persists an empty background completion as a terminal event", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    complete(result.record, "completed", "");

    coordinator.onAgentComplete(result.record);

    expect(mockPi.appendEntry).toHaveBeenCalledWith(
      "subagents-lite:pending-result",
      expect.objectContaining({ agentId: result.agentId, result: "(no output)", status: "completed" }),
    );
    expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["error", "provider failed"],
    ["aborted", null],
    ["turn_limited", null],
    ["stopped", null],
  ] as const)("persists %s terminal metadata before wake", async (status, error) => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    result.record.display.invocation = { providerName: "test-provider", modelName: "test-model" };
    complete(result.record, status, status === "error" ? "" : "partial output");
    result.record.error = error ?? undefined;

    coordinator.onAgentComplete(result.record);

    expect(mockPi.appendEntry).toHaveBeenCalledWith(
      "subagents-lite:pending-result",
      expect.objectContaining({
        agentId: result.agentId,
        type: "builder",
        status,
        error,
        provider: "test-provider",
        model: "test-model",
      }),
    );
    expect(mockPi.appendEntry.mock.invocationCallOrder[0])
      .toBeLessThan(mockPi.sendMessage.mock.invocationCallOrder[0]);
  });

  it("uses follow-up when a completion lands after natural preflight but before the run becomes non-idle", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    expect(coordinator.prepareBeforeAgentStart()).toBeUndefined();
    expect(fallbackMeta.idle).toBe(true);

    const result = await spawnBackground(coordinator);
    complete(result.record, "completed", "preflight result");
    coordinator.onAgentComplete(result.record);
    expect(mockPi.sendMessage).not.toHaveBeenCalled();

    coordinator.onParentAgentStart();
    expect(mockPi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("preflight result") }),
      { deliverAs: "followUp" },
    );
  });

  it("defers a completion from the settled-idle gap until settlement", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    coordinator.prepareBeforeAgentStart();
    coordinator.onParentAgentStart();
    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "stop" }]);

    const result = await spawnBackground(coordinator);
    complete(result.record, "completed", "settled gap result");
    coordinator.onAgentComplete(result.record);
    expect(mockPi.sendMessage).not.toHaveBeenCalled();

    coordinator.onParentSettled();
    await Promise.resolve();
    expect(mockPi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("settled gap result") }),
      { triggerTurn: true },
    );
  });

  it("does not issue another wake while a parent wake is active", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const first = await spawnBackground(coordinator);
    const second = await spawnBackground(coordinator);
    complete(first.record, "completed", "first");
    complete(second.record, "completed", "second");

    coordinator.onAgentComplete(first.record);
    coordinator.onAgentComplete(second.record);

    expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    expect(sessionEntries.filter(entry => entry.customType === "subagents-lite:pending-result")).toHaveLength(2);
  });

  it("restores the session inbox once and maintains pending state in memory", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    complete(result.record, "completed", "cached result");

    coordinator.onAgentComplete(result.record);
    coordinator.pendingResultCount();
    coordinator.pendingResultCount();
    coordinator.getStoredResult(result.agentId);

    expect(mockGetEntries).toHaveBeenCalledTimes(1);
  });

  it("waits off-branch and wakes when navigation returns to the origin subtree", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);

    activeBranchEntries.splice(0, activeBranchEntries.length, { id: "other-branch" });
    fallbackMeta.currentLeafId = "other-branch";
    coordinator.onSessionTree();
    complete(result.record, "completed", "branch-local result");
    coordinator.onAgentComplete(result.record);

    expect(mockPi.appendEntry).toHaveBeenCalledWith(
      "subagents-lite:pending-result",
      expect.objectContaining({ originEntryId: "origin-a", parentSessionId: "test-session" }),
    );
    expect(mockPi.sendMessage).not.toHaveBeenCalled();
    expect(coordinator.prepareBeforeAgentStart()).toBeUndefined();
    expect(coordinator.pendingResultCount()).toBeUndefined();

    activeBranchEntries.splice(0, activeBranchEntries.length, { id: "origin-a" }, { id: "descendant" });
    fallbackMeta.currentLeafId = "descendant";
    coordinator.onSessionTree();

    expect(mockPi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("branch-local result") }),
      { triggerTurn: true },
    );
    expect(coordinator.pendingResultCount()).toBeUndefined();
  });

  it("re-arms a failed result only after explicit tree navigation returns to its origin", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    complete(result.record, "completed", "retry on return");
    coordinator.onAgentComplete(result.record);
    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "error", errorMessage: "EOF" }]);
    coordinator.onParentSettled();
    expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

    activeBranchEntries.splice(0, activeBranchEntries.length, { id: "other-branch" });
    fallbackMeta.currentLeafId = "other-branch";
    coordinator.onSessionTree();
    expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

    activeBranchEntries.splice(0, activeBranchEntries.length, { id: "origin-a" });
    fallbackMeta.currentLeafId = "origin-a";
    coordinator.onSessionTree();

    expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("acknowledges only the result IDs delivered by a successful parent turn", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const first = await spawnBackground(coordinator);
    const second = await spawnBackground(coordinator);
    complete(first.record, "completed", "first");
    complete(second.record, "completed", "second");

    coordinator.onAgentComplete(first.record);
    coordinator.onAgentComplete(second.record);
    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "stop" }]);
    coordinator.onParentSettled();
    await Promise.resolve();

    expect(first.record.lifecycle.resultConsumed).toBe(true);
    expect(second.record.lifecycle.resultConsumed).toBeUndefined();
    expect(sessionEntries.some(entry =>
      entry.customType === "subagents-lite:result-ack"
      && entry.data.deliveryIds.includes(first.record.execution.resultDeliveryId),
    )).toBe(true);
  });

  it("does not let an old wake ack a newer continuation result", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    complete(result.record, "completed", "first result");
    coordinator.onAgentComplete(result.record);
    const firstDeliveryId = result.record.execution.resultDeliveryId;

    complete(result.record, "completed", "continuation result");
    coordinator.onAgentComplete(result.record);

    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "stop" }]);
    coordinator.onParentSettled();
    await Promise.resolve();

    expect(result.record.execution.resultDeliveryId).not.toBe(firstDeliveryId);
    expect(result.record.lifecycle.resultConsumed).toBeUndefined();
    expect(coordinator.getStoredResult(result.agentId)?.result).toContain("continuation result");
  });

  it("does not acknowledge results after an aborted parent turn", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    complete(result.record);
    coordinator.onAgentComplete(result.record);

    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "aborted" }]);
    coordinator.onParentSettled();

    expect(result.record.lifecycle.resultConsumed).toBeUndefined();
    expect(coordinator.pendingResultCount()).toBe(1);
  });

  it("keeps results pending when acknowledgement persistence fails", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    complete(result.record, "completed", "ack me");
    coordinator.onAgentComplete(result.record);
    mockPi.appendEntry.mockImplementation((customType: string, data: unknown) => {
      if (customType === "subagents-lite:result-ack") throw new Error("stale session");
      sessionEntries.push({ type: "custom", customType, data });
    });

    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "stop" }]);
    coordinator.onParentSettled();
    await Promise.resolve();

    expect(result.record.lifecycle.resultConsumed).toBeUndefined();
    expect(coordinator.pendingResultCount()).toBe(1);
    expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("retries persistence when a later parent prompt can append entries", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    complete(result.record, "completed", "retry me");
    mockPi.appendEntry.mockImplementationOnce(() => { throw new Error("stale session"); });

    coordinator.onAgentComplete(result.record);
    expect(mockPi.sendMessage).not.toHaveBeenCalled();

    mockPi.appendEntry.mockImplementation((customType: string, data: unknown) => {
      sessionEntries.push({ type: "custom", customType, data });
    });
    const message = coordinator.prepareBeforeAgentStart();
    expect(message?.content).toContain("retry me");
    expect(result.record.lifecycle.resultPersisted).toBe(true);
  });

  it("keeps results after a failed parent turn and lets a later completion retry", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const first = await spawnBackground(coordinator);
    complete(first.record, "completed", "first");
    coordinator.onAgentComplete(first.record);

    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "error", errorMessage: "auth_unavailable" }]);
    coordinator.onParentSettled();
    expect(coordinator.pendingResultCount()).toBe(1);

    const second = await spawnBackground(coordinator);
    complete(second.record, "completed", "second");
    coordinator.onAgentComplete(second.record);

    expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("lets a completion during a failed parent turn provide the next wake opportunity", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const first = await spawnBackground(coordinator);
    const second = await spawnBackground(coordinator);
    complete(first.record, "completed", "first");
    coordinator.onAgentComplete(first.record);

    complete(second.record, "completed", "second");
    coordinator.onAgentComplete(second.record);
    expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "error", errorMessage: "auth_unavailable" }]);
    coordinator.onParentSettled();
    await Promise.resolve();

    expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);
    expect(mockPi.sendMessage.mock.calls[1][0].content).toContain("first");
    expect(mockPi.sendMessage.mock.calls[1][0].content).toContain("second");
    expect(coordinator.pendingResultCount()).toBeUndefined();

    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "error", errorMessage: "auth_unavailable" }]);
    coordinator.onParentSettled();
    await Promise.resolve();

    expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);
    expect(coordinator.pendingResultCount()).toBe(2);
  });

  it("allows one new wake per later persisted completion and then stops", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const first = await spawnBackground(coordinator);
    const second = await spawnBackground(coordinator);
    const third = await spawnBackground(coordinator);

    complete(first.record, "completed", "first");
    coordinator.onAgentComplete(first.record);
    complete(second.record, "completed", "second");
    coordinator.onAgentComplete(second.record);
    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "error", errorMessage: "EOF" }]);
    coordinator.onParentSettled();
    await Promise.resolve();
    expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);

    complete(third.record, "completed", "third");
    coordinator.onAgentComplete(third.record);
    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "error", errorMessage: "EOF" }]);
    coordinator.onParentSettled();
    await Promise.resolve();
    expect(mockPi.sendMessage).toHaveBeenCalledTimes(3);
    expect(mockPi.sendMessage.mock.calls[2][0].content).toContain("third");

    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "error", errorMessage: "EOF" }]);
    coordinator.onParentSettled();
    await Promise.resolve();
    expect(mockPi.sendMessage).toHaveBeenCalledTimes(3);
  });

  it("does not let an unpersisted completion retrigger a failed wake", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const first = await spawnBackground(coordinator);
    complete(first.record, "completed", "first");
    coordinator.onAgentComplete(first.record);

    const second = await spawnBackground(coordinator);
    complete(second.record, "completed", "second");
    mockPi.appendEntry.mockImplementationOnce(() => { throw new Error("stale session"); });
    coordinator.onAgentComplete(second.record);
    expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "error", errorMessage: "auth_unavailable" }]);
    coordinator.onParentSettled();
    await Promise.resolve();

    expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    expect(sessionEntries.filter(entry => entry.customType === "subagents-lite:pending-result")).toHaveLength(1);
    expect(coordinator.pendingResultCount()).toBe(2);
  });

  it("wakes results recovered while the current completion remains unpersisted", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const first = await spawnBackground(coordinator);
    const second = await spawnBackground(coordinator);
    let pendingAttempts = 0;
    mockPi.appendEntry.mockImplementation((customType: string, data: unknown) => {
      if (customType === "subagents-lite:pending-result") {
        pendingAttempts++;
        if (pendingAttempts !== 2) throw new Error("stale session");
      }
      sessionEntries.push({ type: "custom", customType, data });
    });

    complete(first.record, "completed", "recovered first");
    coordinator.onAgentComplete(first.record);
    expect(mockPi.sendMessage).not.toHaveBeenCalled();

    complete(second.record, "completed", "still unpersisted");
    coordinator.onAgentComplete(second.record);

    expect(sessionEntries.filter(entry => entry.customType === "subagents-lite:pending-result"))
      .toHaveLength(1);
    expect(mockPi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("recovered first") }),
      { triggerTurn: true },
    );
    expect(mockPi.sendMessage.mock.calls[0][0].content).not.toContain("still unpersisted");
    expect(coordinator.pendingResultCount()).toBe(1);
  });

  it("delivers a failed automatic wake on the next natural parent prompt", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    complete(result.record, "completed", "recovered result");
    coordinator.onAgentComplete(result.record);

    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "error", errorMessage: "EOF" }]);
    coordinator.onParentSettled();
    expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    expect(coordinator.pendingResultCount()).toBe(1);

    const message = coordinator.prepareBeforeAgentStart();
    expect(message?.customType).toBe("subagent-result");
    expect(message?.content).toContain("recovered result");

    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "stop" }]);
    coordinator.onParentSettled();

    expect(result.record.lifecycle.resultConsumed).toBe(true);
    expect(coordinator.pendingResultCount()).toBeUndefined();
    expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    expect(sessionEntries.some(entry =>
      entry.customType === "subagents-lite:result-ack"
      && entry.data.deliveryIds.includes(result.record.execution.resultDeliveryId),
    )).toBe(true);
  });

  it("keeps a result pending when its natural retry turn also fails", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    complete(result.record, "completed", "retry later");
    coordinator.onAgentComplete(result.record);

    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "error", errorMessage: "EOF" }]);
    coordinator.onParentSettled();
    coordinator.prepareBeforeAgentStart();
    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "error", errorMessage: "EOF" }]);
    coordinator.onParentSettled();

    expect(result.record.lifecycle.resultConsumed).toBeUndefined();
    expect(coordinator.pendingResultCount()).toBe(1);
    expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("acknowledges an explicitly read result only after the parent turn succeeds", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    complete(result.record, "completed", "explicit result");
    mockPi.sendMessage.mockImplementationOnce(() => { throw new Error("stale context"); });
    coordinator.onAgentComplete(result.record);
    const deliveryId = result.record.execution.resultDeliveryId;

    coordinator.markResultPresented(deliveryId);
    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "stop" }]);
    coordinator.onParentSettled();

    expect(result.record.lifecycle.resultConsumed).toBe(true);
    expect(coordinator.pendingResultCount()).toBeUndefined();
  });

  it("acknowledges an explicitly read result alongside a concurrent automatic follow-up", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const explicit = await spawnBackground(coordinator);
    complete(explicit.record, "completed", "explicit result");
    mockPi.sendMessage.mockImplementationOnce(() => { throw new Error("stale context"); });
    coordinator.onAgentComplete(explicit.record);
    coordinator.markResultPresented(explicit.record.execution.resultDeliveryId);

    fallbackMeta.idle = false;
    const automatic = await spawnBackground(coordinator);
    complete(automatic.record, "completed", "automatic result");
    coordinator.onAgentComplete(automatic.record);
    expect(mockPi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("automatic result") }),
      { deliverAs: "followUp" },
    );

    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "stop" }]);
    coordinator.onParentSettled();

    expect(explicit.record.lifecycle.resultConsumed).toBe(true);
    expect(automatic.record.lifecycle.resultConsumed).toBe(true);
    const ack = sessionEntries.findLast(entry => entry.customType === "subagents-lite:result-ack");
    expect(ack?.data.deliveryIds).toEqual(expect.arrayContaining([
      explicit.record.execution.resultDeliveryId,
      automatic.record.execution.resultDeliveryId,
    ]));
  });

  it("keeps an explicitly read result pending when the parent turn fails", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    complete(result.record, "completed", "explicit result");
    mockPi.sendMessage.mockImplementationOnce(() => { throw new Error("stale context"); });
    coordinator.onAgentComplete(result.record);

    coordinator.markResultPresented(result.record.execution.resultDeliveryId);
    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "error", errorMessage: "EOF" }]);
    coordinator.onParentSettled();

    expect(result.record.lifecycle.resultConsumed).toBeUndefined();
    expect(coordinator.pendingResultCount()).toBe(1);
  });

  it("reads a stored result after the manager record is removed", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    complete(result.record, "completed", "durable result");
    coordinator.onAgentComplete(result.record);
    manager.deleteRecord(result.agentId);

    expect(coordinator.getStoredResult(result.agentId)?.result).toContain("durable result");
  });

  it("reads the current completion instead of an older fallback for the same agent", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    mockPi.appendEntry.mockImplementation((customType: string, data: any) => {
      if (customType === "subagents-lite:pending-result" && data.result === "older fallback") {
        throw new Error("stale session");
      }
      sessionEntries.push({ type: "custom", customType, data });
    });

    complete(result.record, "completed", "older fallback");
    coordinator.onAgentComplete(result.record);
    const olderDeliveryId = result.record.execution.resultDeliveryId;

    complete(result.record, "completed", "current result");
    coordinator.onAgentComplete(result.record);
    const currentDeliveryId = result.record.execution.resultDeliveryId;

    expect(currentDeliveryId).not.toBe(olderDeliveryId);
    expect(coordinator.getStoredResult(result.agentId)).toMatchObject({
      deliveryId: currentDeliveryId,
      result: "current result",
    });

    coordinator.markResultPresented(currentDeliveryId);
    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "stop" }]);
    coordinator.onParentSettled();
    const ack = sessionEntries.findLast(entry => entry.customType === "subagents-lite:result-ack");
    expect(ack?.data.deliveryIds).toContain(currentDeliveryId);
    expect(ack?.data.deliveryIds).not.toContain(olderDeliveryId);
  });

  it("reads the newest completion after record cleanup while an older fallback remains", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    mockPi.appendEntry.mockImplementation((customType: string, data: any) => {
      if (customType === "subagents-lite:pending-result" && data.result === "older fallback") {
        throw new Error("stale session");
      }
      sessionEntries.push({ type: "custom", customType, data });
    });

    const now = vi.spyOn(Date, "now").mockReturnValue(1);
    complete(result.record, "completed", "older fallback");
    coordinator.onAgentComplete(result.record);
    now.mockReturnValue(2);
    complete(result.record, "completed", "newer durable result");
    coordinator.onAgentComplete(result.record);
    now.mockRestore();
    manager.deleteRecord(result.agentId);

    expect(coordinator.getStoredResult(result.agentId)).toMatchObject({
      result: "newer durable result",
    });
  });

  it("does not re-enqueue a result after the manager record was cleared", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    complete(result.record, "completed", "cleared result");
    manager.deleteRecord(result.agentId);

    coordinator.onAgentComplete(result.record);

    expect(mockPi.appendEntry).not.toHaveBeenCalled();
    expect(mockPi.sendMessage).not.toHaveBeenCalled();
  });

  it("does not stage foreground completion or continuation results", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test foreground",
      graceTurns: 6,
      runInBackground: false,
    });
    complete(result.record, "completed", "continuation result");
    coordinator.onAgentComplete(result.record);

    expect(mockPi.appendEntry).not.toHaveBeenCalled();
  });

  it("retains staged results when the pi runtime rejects delivery", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    complete(result.record);
    mockPi.sendMessage.mockImplementation(() => { throw new Error("stale context"); });

    coordinator.onAgentComplete(result.record);

    expect(mockPi.appendEntry).toHaveBeenCalledWith(
      "subagents-lite:pending-result",
      expect.any(Object),
    );
    expect(coordinator.pendingResultCount()).toBe(1);
  });

  it("does not retry a failed running-parent follow-up at settlement without a new Auto completion", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    fallbackMeta.idle = false;
    const result = await spawnBackground(coordinator);
    complete(result.record, "completed", "failed follow-up");
    mockPi.sendMessage.mockImplementationOnce(() => { throw new Error("stale context"); });

    coordinator.onAgentComplete(result.record);
    coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "stop" }]);
    coordinator.onParentSettled();
    await Promise.resolve();

    expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    expect(coordinator.pendingResultCount()).toBe(1);
  });

  it("keeps append failure visible across tree refresh and same-session reload", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    complete(result.record, "completed", "unpersisted");
    mockPi.appendEntry.mockImplementation(() => { throw new Error("stale session"); });

    coordinator.onAgentComplete(result.record);
    expect(coordinator.pendingResultCount()).toBe(1);
    coordinator.onSessionTree();
    expect(coordinator.pendingResultCount()).toBe(1);
    coordinator.dispose();

    const replacement = new SpawnCoordinator(manager as any);
    replacement.restorePending();
    expect(replacement.pendingResultCount()).toBe(1);
  });

  it("flushes an in-memory fallback before disposal", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    complete(result.record, "completed", "flush before dispose");
    mockPi.appendEntry.mockImplementationOnce(() => { throw new Error("stale session"); });
    coordinator.onAgentComplete(result.record);

    mockPi.appendEntry.mockImplementation((customType: string, data: unknown) => {
      sessionEntries.push({ type: "custom", customType, data });
    });
    coordinator.dispose();

    expect(sessionEntries.some(entry =>
      entry.customType === "subagents-lite:pending-result"
      && entry.data.result === "flush before dispose",
    )).toBe(true);
  });

  it("transfers an unpersisted fallback to a replacement coordinator", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    complete(result.record, "completed", "reload result");
    mockPi.appendEntry.mockImplementation(() => { throw new Error("stale session"); });

    coordinator.onAgentComplete(result.record);
    coordinator.dispose();
    expect(fallbackResults).toHaveLength(1);

    mockPi.appendEntry.mockImplementation((customType: string, data: unknown) => {
      sessionEntries.push({ type: "custom", customType, data });
    });
    const replacement = new SpawnCoordinator(manager as any);
    const message = replacement.prepareBeforeAgentStart();

    expect(message?.content).toContain("reload result");
    expect(result.record.lifecycle.resultPersisted).toBe(true);
  });

  it("re-arms restored Auto pending on explicit session reload", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    activeBranchEntries.splice(0, activeBranchEntries.length, { id: "other-branch" });
    fallbackMeta.currentLeafId = "other-branch";
    coordinator.onSessionTree();
    complete(result.record, "completed", "restore me");
    coordinator.onAgentComplete(result.record);
    expect(mockPi.sendMessage).not.toHaveBeenCalled();
    coordinator.dispose();

    activeBranchEntries.splice(0, activeBranchEntries.length, { id: "origin-a" });
    fallbackMeta.currentLeafId = "origin-a";
    const replacement = new SpawnCoordinator(manager as any);
    replacement.restorePending();

    expect(mockPi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("restore me") }),
      { triggerTurn: true },
    );
  });

  it("does not wake after disposal", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await spawnBackground(coordinator);
    coordinator.dispose();
    complete(result.record);

    coordinator.onAgentComplete(result.record);

    expect(mockPi.sendMessage).not.toHaveBeenCalled();
  });
});
