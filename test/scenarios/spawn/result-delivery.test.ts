import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent, continueAgentSession } from "../../../src/agents/agent-runner.js";
import { createAgentScenario, type AgentScenario } from "../../support/agent-scenario.js";
import { mockAgentSession, mockRunResult, fakeOptions } from "../../support/manager.js";
import { makeResolvablePromise } from "../../support/fixtures.js";
import { executeAgentStatusTool } from "../../../src/agents/agent-status.js";
import { readResultEntries } from "../../../src/spawn/result-inbox.js";

vi.mock("../../../src/agents/agent-runner.js", () => ({ runAgent: vi.fn(), continueAgentSession: vi.fn() }));

describe("durable result delivery integration", () => {
  let scenario: AgentScenario;
  let session: ReturnType<typeof mockAgentSession>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    scenario = createAgentScenario();
    session = mockAgentSession();
    session.model = { provider: "test", id: "model" };
    vi.mocked(runAgent).mockReset().mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options.onSessionCreated?.(session);
      return mockRunResult({ responseText: "durable result", session });
    });
    vi.mocked(continueAgentSession).mockReset();
  });

  afterEach(async () => { await scenario.dispose(); });

  it("reads and acknowledges a durable result after TTL cleanup removes the Agent record", async () => {
    const id = scenario.manager.spawn(scenario.pi, scenario.ctx, "reviewer", "review", {
      ...fakeOptions(),
      description: "review",
      modelKey: "test/model",
      resultSessionId: scenario.parent.getSessionId(),
      resultOriginEntryId: scenario.originId,
      invocation: { providerName: "test", modelName: "model" },
    });
    const record = scenario.manager.getRecord(id)!;
    await record.execution.promise;
    expect(record.lifecycle.resultPersisted).toBe(true);

    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(scenario.manager.getRecord(id)).toBeUndefined();

    const status = await executeAgentStatusTool(
      "status-call",
      { agent_id: id },
      undefined,
      undefined,
      scenario.ctx,
    );
    expect(status.content[0].text).toContain("durable result");
    expect(readResultEntries(scenario.ctx).pending.size).toBe(1);

    scenario.persistMessages();
    scenario.coordinator.onParentAgentEnd();
    await scenario.coordinator.onParentSettled();

    expect(readResultEntries(scenario.ctx).pending.size).toBe(0);
  });

  it.each([
    "quota exhausted",
    "invalid API key",
    "content_filter",
  ])("persists a live-session error immediately: %s", async (errorText) => {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options.onSessionCreated?.(session);
      throw new Error(errorText);
    });

    const id = scenario.manager.spawn(scenario.pi, scenario.ctx, "reviewer", "review", {
      ...fakeOptions(),
      description: "review",
      modelKey: "test/model",
      resultSessionId: scenario.parent.getSessionId(),
      resultOriginEntryId: scenario.originId,
    });
    const record = scenario.manager.getRecord(id)!;
    await record.execution.promise;

    expect(record).toMatchObject({
      lifecycle: { status: "error", resultPersisted: true },
      execution: { settled: true, session },
      error: errorText,
    });
    const pending = [...readResultEntries(scenario.ctx).pending.values()];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: "error", error: errorText });
    expect(pending[0].result).toContain(errorText);
    expect(scenario.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it("preserves background delivery identity and creates a new delivery ID after continuation", async () => {
    const id = scenario.manager.spawn(scenario.pi, scenario.ctx, "reviewer", "review", {
      ...fakeOptions(),
      description: "review",
      modelKey: "test/model",
      resultSessionId: scenario.parent.getSessionId(),
      resultOriginEntryId: scenario.originId,
    });
    const record = scenario.manager.getRecord(id)!;
    await record.execution.promise;
    const firstDeliveryId = record.execution.resultDeliveryId!;

    scenario.coordinator.markResultPresented(firstDeliveryId);
    scenario.persistMessages();
    scenario.coordinator.onParentAgentEnd();
    await scenario.coordinator.onParentSettled();
    expect(readResultEntries(scenario.ctx).pending.size).toBe(0);

    vi.mocked(continueAgentSession).mockResolvedValue({
      responseText: "continued result",
      aborted: false,
      turnLimited: false,
    });
    await expect(scenario.coordinator.interact(id, "continue")).resolves.toEqual({ accepted: true });
    await record.execution.promise;
    const delivered = scenario.coordinator.deliverSelectedMessages(id, [0]);
    expect(delivered).toBeDefined();

    expect(record.execution).toMatchObject({
      resultSessionId: scenario.parent.getSessionId(),
      resultOriginEntryId: scenario.originId,
    });
    expect(record.execution).not.toHaveProperty("backgroundDelivery");
    expect(delivered!.deliveryId).not.toBe(firstDeliveryId);
    expect(readResultEntries(scenario.ctx).pending.get(delivered!.deliveryId)?.result)
      .toContain("continued result");
  });

  it("delivers foreground continuation results to the inbox and parent session", async () => {
    const spawned = await scenario.coordinator.spawn(scenario.pi, scenario.ctx, {
      ...fakeOptions(),
      graceTurns: 5,
      type: "reviewer",
      prompt: "review",
      description: "review",
      modelKey: "test/model",
      runInBackground: false,
    });
    vi.mocked(continueAgentSession).mockResolvedValue({
      responseText: "foreground continuation",
      aborted: false,
      turnLimited: false,
    });

    await expect(scenario.coordinator.interact(spawned.agentId, "continue"))
      .resolves.toEqual({ accepted: true });
    await spawned.record.execution.promise;
    const delivered = scenario.coordinator.deliverSelectedMessages(spawned.agentId, [0]);
    expect(delivered).toBeDefined();

    expect(spawned.record.execution.resultSessionId).toBe(scenario.parent.getSessionId());
    expect(spawned.record.execution.resultOriginEntryId).toBe(scenario.originId);
    expect(readResultEntries(scenario.ctx).pending.size).toBe(1);
    expect([...readResultEntries(scenario.ctx).pending.values()][0].result).toContain("foreground continuation");
    expect(scenario.pi.sendMessage).toHaveBeenCalled();
  });

  it("delivers results to the parent session when an interrupted foreground agent is resumed", async () => {
    const controller = new AbortController();
    const runWait = makeResolvablePromise();
    scenario.onDispose(() => runWait.resolve(mockRunResult({ session, aborted: true })));
    vi.mocked(runAgent).mockReturnValue(runWait.promise);

    const spawnPromise = scenario.coordinator.spawn(scenario.pi, scenario.ctx, {
      ...fakeOptions(),
      graceTurns: 5,
      type: "reviewer",
      prompt: "review",
      description: "review",
      modelKey: "test/model",
      runInBackground: false,
      signal: controller.signal,
    });

    controller.abort();
    runWait.resolve({ responseText: "", session, aborted: true, turnLimited: false });
    const spawned = await spawnPromise;
    expect(spawned.record.lifecycle.status).toBe("stopped");

    vi.mocked(continueAgentSession).mockResolvedValue({
      responseText: "completed after esc",
      aborted: false,
      turnLimited: false,
    });

    await expect(scenario.coordinator.interact(spawned.agentId, "resume"))
      .resolves.toEqual({ accepted: true });
    await spawned.record.execution.promise;
    const delivered = scenario.coordinator.deliverSelectedMessages(spawned.agentId, [0]);
    expect(delivered).toBeDefined();

    expect(spawned.record.lifecycle.status).toBe("completed");
    expect(spawned.record.execution.resultSessionId).toBe(scenario.parent.getSessionId());
    expect(readResultEntries(scenario.ctx).pending.size).toBe(1);
    expect([...readResultEntries(scenario.ctx).pending.values()][0].result).toContain("completed after esc");
    expect(scenario.pi.sendMessage).toHaveBeenCalled();
  });
});
