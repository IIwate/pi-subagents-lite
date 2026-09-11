import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent, continueAgentSession } from "../../../src/agents/agent-runner.js";
import { createAgentScenario, type AgentScenario } from "../../support/agent-scenario.js";
import { mockAgentSession, mockRunResult, fakeOptions } from "../../support/manager.js";
import { makeResolvablePromise } from "../../support/fixtures.js";
import { AgentNavigator } from "../../../src/ui/agent-navigator.js";
import { AgentPresentation } from "../../../src/agents/agent-presentation.js";
import { setNavigator } from "../../../src/shell.js";
import { createDefaultConfig } from "../../support/harness.js";

vi.mock("../../../src/agents/agent-runner.js", () => ({ runAgent: vi.fn(), continueAgentSession: vi.fn() }));

describe("human takeover lifecycle", () => {
  let scenario: AgentScenario;
  let session: ReturnType<typeof mockAgentSession>;
  let navigator: AgentNavigator;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    scenario = createAgentScenario({ initialConfig: createDefaultConfig({ concurrency: { default: 1, models: { "worker/model": 1 } } }) });
    navigator = new AgentNavigator(new AgentPresentation(scenario.manager, scenario.coordinator));
    setNavigator(navigator);
    scenario.onDispose(() => navigator.dispose());
    session = mockAgentSession();
    session.model = { provider: "test", id: "model" };
    vi.mocked(runAgent).mockReset().mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options.onSessionCreated?.(session);
      return mockRunResult({ responseText: "default agent response", session });
    });
    vi.mocked(continueAgentSession).mockReset();
  });

  afterEach(async () => { await scenario.dispose(); });

  describe("queuing and takeover", () => {
    it("detaches immediately when an agent is queued due to concurrency limits", async () => {
      // First agent occupies the concurrency limit of worker/model (ceiling = 1)
      let resolveFirst!: (value: any) => void;
      const firstRunPromise = new Promise<Awaited<ReturnType<typeof runAgent>>>((resolve) => { resolveFirst = resolve; });
      scenario.onDispose(() => resolveFirst(mockRunResult({ session, aborted: true })));
      vi.mocked(runAgent).mockReturnValueOnce(firstRunPromise);

      const firstId = scenario.manager.spawn(scenario.pi, scenario.ctx, "Explore", "blocker", {
        ...fakeOptions(),
        description: "Blocker",
        modelKey: "worker/model",
      });
      const firstRecord = scenario.manager.getRecord(firstId)!;
      expect(firstRecord.lifecycle.status).toBe("running");

      // Second agent starts in foreground with the same modelKey -> becomes queued
      const foregroundSpawnPromise = scenario.coordinator.spawn(scenario.pi, scenario.ctx, {
        ...fakeOptions(),
        type: "Explore",
        prompt: "queued foreground task",
        description: "Queued foreground agent",
        graceTurns: 5,
        modelKey: "worker/model",
        runInBackground: false,
      });

      const secondRecord = scenario.manager.listAgents().find((a: { id: string }) => a.id !== firstId)!;
      expect(secondRecord.lifecycle.status).toBe("queued");
      expect(secondRecord.execution.detach).toBeDefined();

      // User interacts in child view while still queued
      scenario.manager.takeOver(secondRecord.id);
      const interactRes = await scenario.coordinator.interact(secondRecord.id, "Steering while queued");
      expect(interactRes).toEqual({ accepted: true });
      expect(secondRecord.execution.pendingSteers?.[0].message).toBe("Steering while queued");

      // Foreground spawn immediately returns with detached = true
      const spawnResult = await foregroundSpawnPromise;
      expect(spawnResult.detached).toBe(true);
      expect(secondRecord.lifecycle.takenOver).toBe(true);
      expect(secondRecord.lifecycle.pinnedAt).toBeDefined();

      // Unblock first agent
      resolveFirst({
        responseText: "Blocker done",
        session,
        aborted: false,
        turnLimited: false,
      });
      await firstRecord.execution.promise;
    });

    it("maintains silent isolation when an agent fails or errors after takeover", async () => {
      let rejectRunner!: (err: any) => void;
      const failing = Promise.withResolvers<Awaited<ReturnType<typeof runAgent>>>();
      rejectRunner = failing.reject;
      const failingPromise = failing.promise;
      scenario.onDispose(() => failing.resolve(mockRunResult({ session, aborted: true })));
      vi.mocked(runAgent).mockReturnValueOnce(failingPromise);

      const spawnPromise = scenario.coordinator.spawn(scenario.pi, scenario.ctx, {
        ...fakeOptions(),
        type: "Explore",
        prompt: "Will fail later",
        description: "Error test",
        graceTurns: 5,
        runInBackground: true,
      });
      const spawnResult = await spawnPromise;
      const record = spawnResult.record;

      // User takes over
      scenario.manager.takeOver(record.id);
      await scenario.coordinator.interact(record.id, "Takeover before crash");
      expect(record.lifecycle.takenOver).toBe(true);

      // Agent throws an error in background runner
      rejectRunner(new Error("Subagent out of memory"));
      await record.execution.promise;

      // Ensure completion handler did not wake parent or persist result
      expect(scenario.pi.sendMessage).not.toHaveBeenCalled();
      expect(scenario.parent.getEntries().filter(entry => entry.type === "custom").length).toBe(0);
    });

    it("delivers stored final text when a taken-over session has no transcript messages", async () => {
      const id = scenario.manager.spawn(scenario.pi, scenario.ctx, "Explore", "Finished task", {
        ...fakeOptions(),
        description: "Completed inspect",
      });
      const record = scenario.manager.getRecord(id)!;
      scenario.manager.takeOver(id);
      expect(await scenario.coordinator.interact(id, "Review the result")).toEqual({ accepted: true });
      await record.execution.promise;
      expect(navigator.canDeliverRecord(new AgentPresentation(scenario.manager).getRecord(record.id))).toBe(true);
      expect(scenario.coordinator.getDeliverableMessages(id)).toEqual([
        { role: "assistant", content: "default agent response" },
      ]);
      const deliveredSelection = scenario.coordinator.deliverSelectedMessages(
        id, scenario.coordinator.getDeliverableMessages(id).filter((_, index) => [0].includes(index)),
      );
      expect(deliveredSelection.status).toBe("saved");
      if (deliveredSelection.status === "rejected") throw new Error("Selection was rejected");
      const delivered = deliveredSelection.delivery;
      expect(delivered?.result).toContain("### Delivered Output");
      expect(delivered?.result).toContain("default agent response");
    });

    it("notifies navigator.update() immediately when subsequent continuations complete", async () => {
      const updateSpy = vi.spyOn(navigator, "update");

      // Foreground spawn
      const initialRun = makeResolvablePromise();
      scenario.onDispose(() => initialRun.resolve(mockRunResult({ session, aborted: true })));
      vi.mocked(runAgent).mockReturnValue(initialRun.promise);

      const spawnPromise = scenario.coordinator.spawn(scenario.pi, scenario.ctx, {
        type: "general-purpose",
        prompt: "foreground task",
        description: "Task",
        graceTurns: 5,
        runInBackground: false,
        acceptedPolicy: fakeOptions().acceptedPolicy,
      });

      const record = scenario.manager.listAgents()[0];
      // User presses Esc in child view to stop the subagent
      scenario.manager.abort(record.id, "user");
      initialRun.resolve({ responseText: "", session, aborted: true, turnLimited: false });
      await spawnPromise;
      expect(record.lifecycle.status).toBe("stopped");

      // 1st continuation
      const cont1 = makeResolvablePromise();
      scenario.onDispose(() => cont1.resolve(mockRunResult({ session, aborted: true })));
      vi.mocked(continueAgentSession).mockReturnValue(cont1.promise);
      scenario.manager.takeOver(record.id);
      await scenario.coordinator.interact(record.id, "1st continuation");
      expect(record.lifecycle.takenOver).toBe(true);

      cont1.resolve({ responseText: "1st output", aborted: false, turnLimited: false });
      await record.execution.promise;
      expect(record.lifecycle.status).toBe("completed");

      // 2nd continuation
      const cont2 = makeResolvablePromise();
      scenario.onDispose(() => cont2.resolve(mockRunResult({ session, aborted: true })));
      vi.mocked(continueAgentSession).mockReturnValue(cont2.promise);
      scenario.manager.takeOver(record.id);
      await scenario.coordinator.interact(record.id, "2nd continuation");
      expect(record.lifecycle.status).toBe("running");

      updateSpy.mockClear();
      cont2.resolve({ responseText: "123", aborted: false, turnLimited: false });
      await record.execution.promise;
      expect(record.lifecycle.status).toBe("completed");

      // Must be called immediately on 2nd continuation completion
      expect(updateSpy).toHaveBeenCalled();
    });
  });

  describe("delivery and retention", () => {
    it("supports 3 consecutive stages of delivery with distinct IDs and preserves Pin", async () => {
      const recordId = scenario.manager.spawn(
        scenario.pi,
        scenario.ctx,
        "general-purpose",
        "Three-stage research task",
        {
      ...fakeOptions(), description: "Complex research", },
      );
      const record = scenario.manager.getRecord(recordId)!;
      session.messages = [
          { role: "user", content: "Step 1 question" },
          { role: "assistant", content: "Step 1 answer" },
          { role: "user", content: "Step 2 question" },
          { role: "assistant", content: "Step 2 answer" },
          { role: "user", content: "Step 3 question" },
          { role: "assistant", content: "Step 3 answer" },
      ];
      scenario.manager.takeOver(recordId);
      expect(await scenario.coordinator.interact(recordId, "Review results")).toEqual({ accepted: true });
      await record.execution.promise;

      // Stage 1: deliver step 1 answer
      const d1Selection = scenario.coordinator.deliverSelectedMessages(
        recordId, scenario.coordinator.getDeliverableMessages(recordId).filter((_, index) => [1].includes(index)),
      );
      expect(d1Selection.status).toBe("saved");
      if (d1Selection.status === "rejected") throw new Error("Selection was rejected");
      const d1 = d1Selection.delivery;
      expect(d1).toBeDefined();
      expect(d1.result).toContain("Step 1 answer");
      expect(d1.result).toContain("### Delivered Output");

      // Stage 2: deliver step 2 transcript
      const d2Selection = scenario.coordinator.deliverSelectedMessages(
        recordId, scenario.coordinator.getDeliverableMessages(recordId).filter((_, index) => [2, 3].includes(index)),
      );
      expect(d2Selection.status).toBe("saved");
      if (d2Selection.status === "rejected") throw new Error("Selection was rejected");
      const d2 = d2Selection.delivery;
      expect(d2).toBeDefined();
      expect(d2.deliveryId).not.toBe(d1.deliveryId);
      expect(d2.result).toContain("### Delivered Transcript");
      expect(d2.result).toContain("**User:**\nStep 2 question");
      expect(d2.result).toContain("**Assistant:**\nStep 2 answer");

      // Stage 3: deliver full accumulated transcript
      const d3Selection = scenario.coordinator.deliverSelectedMessages(
        recordId, scenario.coordinator.getDeliverableMessages(recordId).filter((_, index) => [0, 1, 2, 3, 4, 5].includes(index)),
      );
      expect(d3Selection.status).toBe("saved");
      if (d3Selection.status === "rejected") throw new Error("Selection was rejected");
      const d3 = d3Selection.delivery;
      expect(d3).toBeDefined();
      expect(d3.deliveryId).not.toBe(d2.deliveryId);
      expect(d3.result).toContain("Step 3 answer");

      // Record remains pinned and active
      expect(record.lifecycle.pinnedAt).toBeDefined();

      await record.execution.promise;
      await vi.advanceTimersByTimeAsync(15 * 60_000);

      // Pinned record MUST NOT be removed!
      expect(scenario.manager.getRecord(recordId)).toBeDefined();
    });
  });
});
