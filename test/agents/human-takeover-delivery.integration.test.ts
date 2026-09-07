import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeResolvablePromise } from "../fixtures.ts";

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
  getStore: () => ({
    get agent() {
      return { graceTurns: 5, forceBackground: false };
    },
    get routing() {
      return { enabled: false, enabledProviders: [], agentAccess: {} };
    },
  }),
}));

import { AgentManager } from "../../src/agents/agent-manager.js";
import { executeAgentTool } from "../../src/agents/tool-execution.js";
import { registerAgents } from "../../src/agents/agent-types.js";
import { SpawnCoordinator } from "../../src/spawn/spawn-coordinator.js";

describe("human takeover and selective delivery integration", () => {
  beforeEach(() => {
    registerAgents(new Map());
    state.entries.length = 0;
    state.runAgent.mockReset();
    state.continueAgentSession.mockReset();
    state.session = {
      model: { provider: "test", id: "model" },
      isStreaming: false,
      extensionRunner: { emit: vi.fn(async () => {}) },
      steer: vi.fn(async () => {}),
      dispose: vi.fn(),
      messages: [
        { role: "user", content: "Plan the migration." },
        { role: "assistant", content: "Migration plan step 1: schema update." },
        { role: "user", content: "What about step 2?" },
        { role: "assistant", content: "Step 2: data migration script." },
      ],
    };
    state.runAgent.mockResolvedValue({
      responseText: "durable result",
      session: state.session,
      aborted: false,
      turnLimited: false,
    });
    state.ctx = {
      cwd: "/repo",
      model: { provider: "test", id: "model" },
      scopedModels: [],
      modelRegistry: { getAvailable: () => [] },
      isIdle: () => true,
      sessionManager: {
        getSessionId: () => "parent-session",
        getLeafId: () => "leaf-a",
        getBranch: () => [{ id: "leaf-a" }],
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

  it("detaches foreground subagent immediately on interact and frees main session", async () => {
    const runDeferred = makeResolvablePromise();
    state.runAgent.mockReturnValue(runDeferred.promise);

    // Spawn in foreground
    const toolExecutionPromise = executeAgentTool(
      "call-1",
      { agent: "general-purpose", prompt: "Run heavy task", run_in_background: false },
      undefined,
      undefined,
      state.ctx,
    );

    const record = state.manager.listAgents()[0];
    expect(record).toBeDefined();
    record.execution.session = state.session;

    // User takes over in child view
    const interactResult = await state.coordinator.interact(record.id, "I will take over here");
    expect(interactResult).toEqual({ accepted: true });

    // Foreground tool execution should resolve immediately with detachment notice
    const toolResult = await toolExecutionPromise;
    expect(toolResult.isError).toBeUndefined();
    expect(toolResult.content[0].text).toContain("[Subagent detached to background:");
    expect(toolResult.content[0].text).toContain("User took over this session interactively in the child view");

    // Lifecycle marked takenOver and pinned
    expect(record.lifecycle.takenOver).toBe(true);
    expect(typeof record.lifecycle.pinnedAt).toBe("number");
    expect(record.execution.resultSessionId).toBe("parent-session");

    // Subagent finishes run in background
    runDeferred.resolve({
      responseText: "Task completed after steer",
      session: state.session,
      aborted: false,
      turnLimited: false,
    });
    await record.execution.promise;

    // Because it is takenOver, parent session remains completely silent
    expect(state.pi.sendMessage).not.toHaveBeenCalled();
    expect(state.entries.length).toBe(0);
  });

  it("allows multi-selection delivery with fences and wakes parent session", () => {
    const record = state.manager.spawn(
      state.pi,
      state.ctx,
      "general-purpose",
      "Investigate bug",
      { description: "Investigate memory leak", runInBackground: true },
    );
    const agentRecord = state.manager.getRecord(record)!;
    agentRecord.lifecycle.takenOver = true;
    agentRecord.lifecycle.pinnedAt = Date.now();
    agentRecord.execution.session = state.session;

    // Deliver assistant messages only -> Delivered Output
    const delivered1 = state.coordinator.deliverSelectedMessages(record, [1, 3]);
    expect(delivered1).toBeDefined();
    expect(delivered1.result).toContain("[Subagent Result: general-purpose (completed)]");
    expect(delivered1.result).toContain('Task Origin: "Investigate memory leak"');
    expect(delivered1.result).toContain("### Delivered Output");
    expect(delivered1.result).toContain("Migration plan step 1: schema update.\n\n---\n\nStep 2: data migration script.");
    expect(agentRecord.lifecycle.resultPersisted).toBe(true);

    // Parent was woken with triggerTurn: true
    expect(state.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-result" }),
      { triggerTurn: true },
    );

    // Subagent remains pinned and alive
    expect(agentRecord.lifecycle.pinnedAt).toBeDefined();

    // Stage 2: Deliver transcript with user instruction -> Delivered Transcript
    const delivered2 = state.coordinator.deliverSelectedMessages(record, [0, 1]);
    expect(delivered2).toBeDefined();
    expect(delivered2.deliveryId).not.toBe(delivered1.deliveryId);
    expect(delivered2.result).toContain("### Delivered Transcript");
    expect(delivered2.result).toContain("**User:**\nPlan the migration.");
    expect(delivered2.result).toContain("**Assistant:**\nMigration plan step 1: schema update.");
  });

  it("preserves autonomous delivery for untouched background agents", async () => {
    state.runAgent.mockResolvedValue({
      responseText: "autonomous background completion",
      session: state.session,
      aborted: false,
      turnLimited: false,
    });

    await state.coordinator.spawn(state.pi, state.ctx, {
      type: "general-purpose",
      prompt: "background task",
      description: "Autonomous task",
      graceTurns: 5,
      runInBackground: true,
      acceptedPolicy: {} as any,
    });

    const record = state.manager.listAgents()[0];
    expect(record.lifecycle.takenOver).toBeUndefined();

    // Simulate completion
    state.coordinator.onAgentComplete(record);

    // Normal delivery happens automatically
    expect(state.pi.appendEntry).toHaveBeenCalledWith(
      "subagents-lite:pending-result",
      expect.objectContaining({ agentId: record.id, result: "autonomous background completion" }),
    );
    expect(state.pi.sendMessage).toHaveBeenCalled();
  });
});
