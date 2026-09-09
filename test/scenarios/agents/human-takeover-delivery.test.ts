import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent, continueAgentSession } from "../../../src/agents/agent-runner.js";
import { createAgentScenario, type AgentScenario } from "../../support/agent-scenario.js";
import { mockAgentSession, mockRunResult, fakeOptions } from "../../support/manager.js";
import { makeResolvablePromise } from "../../support/fixtures.js";
import { executeAgentTool } from "../../../src/agents/tool-execution.js";

vi.mock("../../../src/agents/agent-runner.js", () => ({ runAgent: vi.fn(), continueAgentSession: vi.fn() }));

describe("human takeover and selective delivery integration", () => {
  let scenario: AgentScenario;
  let session: ReturnType<typeof mockAgentSession>;

  beforeEach(() => {
    scenario = createAgentScenario();
    session = mockAgentSession();
    session.model = { provider: "test", id: "model" };
    session.messages = [
      { role: "user", content: "Plan the migration." },
      { role: "assistant", content: "Migration plan step 1: schema update." },
      { role: "user", content: "What about step 2?" },
      { role: "assistant", content: "Step 2: data migration script." },
    ];
    vi.mocked(runAgent).mockReset().mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options.onSessionCreated?.(session);
      return mockRunResult({ responseText: "durable result", session });
    });
    vi.mocked(continueAgentSession).mockReset();
  });

  afterEach(async () => { await scenario.dispose(); });

  it("detaches foreground subagent immediately on interact and frees main session", async () => {
    const runDeferred = makeResolvablePromise();
    scenario.onDispose(() => runDeferred.resolve(mockRunResult({ session, aborted: true })));
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options.onSessionCreated?.(session);
      return runDeferred.promise;
    });

    // Spawn in foreground
    const toolExecutionPromise = executeAgentTool(
      "call-1",
      { agent: "general-purpose", prompt: "Run heavy task", run_in_background: false },
      undefined,
      undefined,
      scenario.ctx,
    );

    const record = scenario.manager.listAgents()[0];
    expect(record).toBeDefined();

    // User takes over in child view
    const interactResult = await scenario.coordinator.interact(record.id, "I will take over here");
    expect(interactResult).toEqual({ accepted: true });

    // Foreground tool execution should resolve immediately with detachment notice
    const toolResult = await toolExecutionPromise;
    expect(toolResult.isError).toBeUndefined();
    expect(toolResult.content[0].text).toContain("[Subagent detached to background:");
    expect(toolResult.content[0].text).toContain("User took over this session interactively in the child view");

    // Lifecycle marked takenOver and pinned
    expect(record.lifecycle.takenOver).toBe(true);
    expect(typeof record.lifecycle.pinnedAt).toBe("number");
    expect(record.execution.resultSessionId).toBe(scenario.parent.getSessionId());

    // Subagent finishes run in background
    runDeferred.resolve({
      responseText: "Task completed after steer",
      session,
      aborted: false,
      turnLimited: false,
    });
    await record.execution.promise;

    // Because it is takenOver, parent session remains completely silent
    expect(scenario.pi.sendMessage).not.toHaveBeenCalled();
    expect(scenario.parent.getEntries().filter(entry => entry.type === "custom").length).toBe(0);
  });

  it("allows multi-selection delivery with fences and wakes parent session", async () => {
    const record = scenario.manager.spawn(
      scenario.pi,
      scenario.ctx,
      "general-purpose",
      "Investigate bug",
      {
      ...fakeOptions(), description: "Investigate memory leak", },
    );
    const agentRecord = scenario.manager.getRecord(record)!;
    expect(await scenario.coordinator.interact(record, "Review the available results")).toEqual({ accepted: true });
    await agentRecord.execution.promise;

    // Deliver assistant messages only -> Delivered Output
    const delivered1 = scenario.coordinator.deliverSelectedMessages(record, [1, 3]);
    expect(delivered1).toBeDefined();
    expect(delivered1!.result).toContain("[Subagent Result: general-purpose (completed)]");
    expect(delivered1!.result).toContain('Task Origin: "Investigate memory leak"');
    expect(delivered1!.result).toContain("### Delivered Output");
    expect(delivered1!.result).toContain("Migration plan step 1: schema update.\n\n---\n\nStep 2: data migration script.");
    expect(agentRecord.lifecycle.resultPersisted).toBe(true);

    // Parent was woken with triggerTurn: true
    expect(scenario.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-result" }),
      { triggerTurn: true },
    );

    // Subagent remains pinned and alive
    expect(agentRecord.lifecycle.pinnedAt).toBeDefined();

    // Stage 2: Deliver transcript with user instruction -> Delivered Transcript
    const delivered2 = scenario.coordinator.deliverSelectedMessages(record, [0, 1]);
    expect(delivered2).toBeDefined();
    expect(delivered2!.deliveryId).not.toBe(delivered1!.deliveryId);
    expect(delivered2!.result).toContain("### Delivered Transcript");
    expect(delivered2!.result).toContain("**User:**\nPlan the migration.");
    expect(delivered2!.result).toContain("**Assistant:**\nMigration plan step 1: schema update.");
  });

  it("preserves autonomous delivery for untouched background agents", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "autonomous background completion",
      session,
      aborted: false,
      turnLimited: false,
    });

    await scenario.coordinator.spawn(scenario.pi, scenario.ctx, {
      type: "general-purpose",
      prompt: "background task",
      description: "Autonomous task",
      graceTurns: 5,
      runInBackground: true,
      acceptedPolicy: fakeOptions().acceptedPolicy,
    });

    const record = scenario.manager.listAgents()[0];
    expect(record.lifecycle.takenOver).toBeUndefined();

    await record.execution.promise;

    // Normal delivery happens automatically
    expect(scenario.pi.appendEntry).toHaveBeenCalledWith(
      "subagents-lite:pending-result",
      expect.objectContaining({ agentId: record.id, result: "autonomous background completion" }),
    );
    expect(scenario.pi.sendMessage).toHaveBeenCalled();
  });
});
