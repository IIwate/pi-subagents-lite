import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent, continueAgentSession } from "../../../src/agents/agent-runner.js";
import { createAgentScenario, type AgentScenario } from "../../support/agent-scenario.js";
import { mockAgentSession, mockRunResult, fakeOptions } from "../../support/manager.js";
import { makeResolvablePromise } from "../../support/fixtures.js";
import { executeAgentTool } from "../../../src/agents/tool-execution.js";
import { AgentNavigator } from "../../../src/ui/agent-navigator.js";
import type { DeliverySelectorComponent } from "../../../src/ui/delivery-selector.js";
import { makeTui, makeUI } from "../../support/navigator.js";
import * as shell from "../../../src/shell.js";

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

  it.each(["append", "replace", "compact"])("retries the displayed snapshot after session messages %s", async mutation => {
    const id = scenario.manager.spawn(scenario.pi, scenario.ctx, "Explore", "Inspect", fakeOptions());
    const record = scenario.manager.getRecord(id)!;
    await scenario.coordinator.interact(id, "Review results");
    await record.execution.promise;
    const previewed = "Previewed report\x07";
    session.messages = [{ role: "user", content: "Original instruction" }, { role: "assistant", content: previewed }];

    const navigator = new AgentNavigator(scenario.manager);
    scenario.onDispose(() => navigator.dispose());
    const ui = makeUI({ value: "" });
    const modal = Promise.withResolvers<boolean>();
    const done = vi.fn((saved: boolean) => modal.resolve(saved));
    let selector!: DeliverySelectorComponent;
    navigator.setUICtx({ ...ui.ctx, custom: (factory: any) => {
      selector = factory(makeTui(), ui.theme, null, done);
      return modal.promise;
    } } as any);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    const opening = navigator.openDeliverySelector();
    scenario.onDispose(async () => { modal.resolve(false); await opening; });
    expect(selector.render(80).join("\n")).toContain("Previewed report");

    if (mutation === "append") {
      session.messages.push({ role: "assistant", content: "Replacement report" });
    } else {
      session.messages = mutation === "compact"
        ? [{ role: "assistant", content: "Compacted report" }]
        : [{ role: "user", content: "Replacement instruction" }, { role: "assistant", content: "Replacement report" }];
    }
    scenario.pi.appendEntry.mockImplementationOnce(() => { throw new Error("Parent log unavailable"); });
    selector.handleInput("\r");
    const deliveryId = record.execution.resultDeliveryId!;
    expect(done).not.toHaveBeenCalled();
    expect(selector.render(80).join("\n")).toContain("Save failed");
    expect(scenario.pi.sendMessage).not.toHaveBeenCalled();
    selector.handleInput(" ");
    expect([...selector.selectedIndices]).toEqual([1]);

    selector.handleInput("\r");
    await opening;
    expect(done).toHaveBeenCalledExactlyOnceWith(true);
    expect(record.execution.resultDeliveryId).toBe(deliveryId);
    const saved = scenario.coordinator.getStoredResult(id)!;
    expect(saved.result).toContain(previewed);
    expect(saved.result).not.toContain("Replacement report");
    expect(saved.result).not.toContain("Compacted report");
    expect(saved.result).toContain("(selected messages)");
    expect(scenario.parent.getEntries().filter(entry => entry.type === "custom"
      && entry.customType === "subagents-lite:pending-result")).toHaveLength(1);
    expect(scenario.parent.getEntries().filter(entry => entry.type === "custom"
      && entry.customType === "subagents-lite:result-ack")).toHaveLength(0);
  });

  it.each(["removed", "parent changed", "empty"])("rejects an invalid selection target: %s", async invalid => {
    const id = scenario.manager.spawn(scenario.pi, scenario.ctx, "Explore", "Inspect", fakeOptions());
    const record = scenario.manager.getRecord(id)!;
    await scenario.coordinator.interact(id, "Review results");
    await record.execution.promise;
    const messages = scenario.coordinator.getDeliverableMessages(id);
    if (invalid === "removed") scenario.manager.clear(id);
    if (invalid === "parent changed") {
      vi.spyOn(shell, "getSessionCtx").mockReturnValue({
        ...scenario.ctx,
        sessionManager: { getSessionId: () => "another-parent", getSessionFile: () => undefined },
      } as any);
    }
    expect(scenario.coordinator.deliverSelectedMessages(id, invalid === "empty" ? [] : messages)).toEqual({
      status: "rejected", reason: invalid === "empty" ? "empty" : "unavailable",
    });
    expect(scenario.pi.appendEntry).not.toHaveBeenCalled();
    expect(scenario.pi.sendMessage).not.toHaveBeenCalled();
  });

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
    const delivered1Selection = scenario.coordinator.deliverSelectedMessages(
      record, scenario.coordinator.getDeliverableMessages(record).filter((_, index) => [1, 3].includes(index)),
    );
    expect(delivered1Selection.status).toBe("saved");
    if (delivered1Selection.status === "rejected") throw new Error("Selection was rejected");
    const delivered1 = delivered1Selection.delivery;
    expect(delivered1).toBeDefined();
    expect(delivered1!.result).toContain("[Subagent Result: general-purpose (selected messages)]");
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
    const delivered2Selection = scenario.coordinator.deliverSelectedMessages(
      record, scenario.coordinator.getDeliverableMessages(record).filter((_, index) => [0, 1].includes(index)),
    );
    expect(delivered2Selection.status).toBe("saved");
    if (delivered2Selection.status === "rejected") throw new Error("Selection was rejected");
    const delivered2 = delivered2Selection.delivery;
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
