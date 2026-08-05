import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  entries: [] as any[],
  manager: undefined as any,
  coordinator: undefined as any,
  session: undefined as any,
  ctx: undefined as any,
  pi: undefined as any,
  runAgent: vi.fn(),
  continueAgentSession: vi.fn(),
}));

vi.mock("../../src/agents/agent-runner.js", () => ({
  runAgent: state.runAgent,
  continueAgentSession: state.continueAgentSession,
}));

vi.mock("../../src/shell.js", () => ({
  getManager: () => state.manager,
  getCoordinator: () => state.coordinator,
  getNavigator: () => undefined,
  getPiInstance: () => state.pi,
  getSessionCtx: () => state.ctx,
  takeFallbackResults: () => [],
  setFallbackResults: vi.fn(),
}));

import { AgentManager } from "../../src/agents/agent-manager.js";
import { executeAgentStatusTool } from "../../src/agents/agent-status.js";
import { readResultEntries } from "../../src/spawn/result-inbox.js";
import { SpawnCoordinator } from "../../src/spawn/spawn-coordinator.js";

describe("durable result delivery integration", () => {
  beforeEach(() => {
    state.entries.length = 0;
    state.runAgent.mockReset();
    state.continueAgentSession.mockReset();
    state.session = {
      model: { provider: "test", id: "model" },
      isStreaming: false,
      extensionRunner: { emit: vi.fn(async () => {}) },
      dispose: vi.fn(),
    };
    state.runAgent.mockResolvedValue({
      responseText: "durable result",
      session: state.session,
      aborted: false,
      turnLimited: false,
    });
    state.ctx = {
      sessionManager: {
        getSessionId: () => "parent-session",
        getLeafId: () => "origin-a",
        getBranch: () => [{ id: "origin-a" }],
        getEntries: () => state.entries,
      },
    };
    state.pi = {
      appendEntry: vi.fn((customType: string, data: unknown) => {
        state.entries.push({ type: "custom", customType, data });
      }),
      sendMessage: vi.fn(),
    };
    state.manager = new AgentManager(undefined);
    state.coordinator = new SpawnCoordinator(state.manager);
    state.manager.setOnComplete((record: any) => state.coordinator.onAgentComplete(record));
  });

  afterEach(async () => {
    state.coordinator.dispose();
    await state.manager.dispose();
  });

  it("reads and acknowledges a durable result after TTL cleanup removes the Agent record", async () => {
    const id = state.manager.spawn(state.pi, state.ctx, "reviewer", "review", {
      description: "review",
      modelKey: "test/model",
      resultSessionId: "parent-session",
      resultOriginEntryId: "origin-a",
      invocation: { providerName: "test", modelName: "model" },
    });
    const record = state.manager.getRecord(id)!;
    await record.execution.promise;
    expect(record.lifecycle.resultPersisted).toBe(true);

    record.lifecycle.completedAt = Date.now() - 20 * 60_000;
    (state.manager as any).cleanup();
    expect(state.manager.getRecord(id)).toBeUndefined();

    const status = await executeAgentStatusTool(
      "status-call",
      { agent_id: id },
      undefined,
      undefined,
      state.ctx,
    );
    expect(status.content[0].text).toContain("durable result");
    expect(readResultEntries(state.ctx).pending.size).toBe(1);

    state.coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "stop" }]);
    state.coordinator.onParentSettled();

    expect(readResultEntries(state.ctx).pending.size).toBe(0);
  });

  it("preserves background delivery identity and creates a new delivery ID after continuation", async () => {
    const id = state.manager.spawn(state.pi, state.ctx, "reviewer", "review", {
      description: "review",
      modelKey: "test/model",
      resultSessionId: "parent-session",
      resultOriginEntryId: "origin-a",
    });
    const record = state.manager.getRecord(id)!;
    await record.execution.promise;
    const firstDeliveryId = record.execution.resultDeliveryId;

    state.coordinator.markResultPresented(firstDeliveryId);
    state.coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "stop" }]);
    state.coordinator.onParentSettled();
    expect(readResultEntries(state.ctx).pending.size).toBe(0);

    state.continueAgentSession.mockResolvedValue({
      responseText: "continued result",
      aborted: false,
      turnLimited: false,
    });
    await expect(state.coordinator.interact(id, "continue")).resolves.toEqual({ accepted: true });
    await record.execution.promise;

    expect(record.execution).toMatchObject({
      resultSessionId: "parent-session",
      resultOriginEntryId: "origin-a",
    });
    expect(record.execution).not.toHaveProperty("backgroundDelivery");
    expect(record.execution.resultDeliveryId).not.toBe(firstDeliveryId);
    expect(readResultEntries(state.ctx).pending.get(record.execution.resultDeliveryId)?.result)
      .toBe("continued result");
  });

  it("keeps foreground continuation results out of the inbox", async () => {
    const spawned = await state.coordinator.spawn(state.pi, state.ctx, {
      type: "reviewer",
      prompt: "review",
      description: "review",
      modelKey: "test/model",
      runInBackground: false,
    });
    state.continueAgentSession.mockResolvedValue({
      responseText: "foreground continuation",
      aborted: false,
      turnLimited: false,
    });

    await expect(state.coordinator.interact(spawned.agentId, "continue"))
      .resolves.toEqual({ accepted: true });
    await spawned.record.execution.promise;

    expect(spawned.record.execution.resultSessionId).toBeUndefined();
    expect(spawned.record.execution).not.toHaveProperty("backgroundDelivery");
    expect(readResultEntries(state.ctx).pending.size).toBe(0);
  });
});
