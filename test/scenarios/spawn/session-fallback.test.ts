import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../../../src/agents/agent-runner.js";
import { executeAgentStatusTool } from "../../../src/agents/agent-status.js";
import { setCoordinator, setManager, setPiInstance, setSessionCtx } from "../../../src/shell.js";
import { readResultEntries } from "../../../src/spawn/result-inbox.js";
import { SpawnCoordinator } from "../../../src/spawn/spawn-coordinator.js";
import { createAgentScenario, type AgentScenario } from "../../support/agent-scenario.js";
import { fakeOptions, mockRunResult } from "../../support/manager.js";

vi.mock("../../../src/agents/agent-runner.js", () => ({ runAgent: vi.fn(), continueAgentSession: vi.fn() }));

describe("session-keyed coordinator fallback", () => {
  const scenarios: AgentScenario[] = [];
  afterEach(async () => {
    while (scenarios.length > 0) await scenarios.pop()!.dispose();
  });

  it("preserves A across B and restores one durable delivery when A returns", async () => {
    const first = createAgentScenario();
    scenarios.push(first);
    first.pi.appendEntry.mockImplementation(() => { throw new Error("stale parent session"); });
    vi.mocked(runAgent).mockResolvedValue(mockRunResult({ responseText: "result from A" }));

    const spawned = await first.coordinator.spawn(first.pi, first.ctx, {
      ...fakeOptions(), type: "reviewer", prompt: "review", description: "review",
      modelKey: "test/model", graceTurns: 6, runInBackground: true,
    });
    await spawned.record.execution.promise;
    expect(spawned.record.lifecycle.resultPersisted).toBeUndefined();
    expect(first.coordinator.pendingResultCount()).toBe(1);
    first.coordinator.dispose();

    const second = createAgentScenario();
    scenarios.push(second);
    await second.coordinator.restorePending();
    expect(second.parent.getEntries().filter(entry => entry.type === "custom")).toEqual([]);
    expect(second.coordinator.pendingResultCount()).toBeUndefined();
    expect(second.pi.sendMessage).not.toHaveBeenCalled();
    second.coordinator.dispose();

    first.pi.appendEntry.mockImplementation((type, data) => { first.parent.appendCustomEntry(type, data); });
    setSessionCtx(first.ctx);
    setPiInstance(first.pi);
    setManager(first.manager);
    const restored = new SpawnCoordinator(first.manager);
    setCoordinator(restored);
    first.manager.setOnComplete(record => restored.onAgentComplete(record));
    first.onDispose(() => restored.dispose());
    await restored.restorePending();

    expect(first.parent.getEntries().filter(entry => entry.type === "custom"
      && entry.customType === "subagents-lite:pending-result")).toHaveLength(1);
    expect(first.pi.sendMessage).toHaveBeenCalledOnce();
    expect(spawned.record.lifecycle.resultPersisted).toBe(true);

    const status = await executeAgentStatusTool("status", { agent_id: spawned.agentId }, undefined, undefined, first.ctx);
    expect(status.content[0].text).toContain("result from A");
    first.parent.appendMessage({
      role: "toolResult", toolCallId: "status", toolName: "AgentStatus",
      content: status.content, details: status.details, isError: false, timestamp: Date.now(),
    });
    restored.onParentAgentEnd();
    await restored.onParentSettled();

    expect(readResultEntries(first.ctx).pending.size).toBe(0);
    expect(first.parent.getEntries().filter(entry => entry.type === "custom"
      && entry.customType === "subagents-lite:result-ack")).toHaveLength(1);
    expect(second.parent.getEntries().filter(entry => entry.type === "custom")).toEqual([]);
  });
});
