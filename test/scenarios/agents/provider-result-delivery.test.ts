import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAgentTool } from "../../../src/agents/tool-execution.js";
import { createPiAgentScenario, type PiAgentScenario } from "../../support/pi-agent-scenario.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { readResultEntries } from "../../../src/spawn/result-inbox.js";

function params(description: string, model?: string, background = true, agent = "general-purpose") {
  return {
    agent,
    prompt: description,
    description,
    run_in_background: background,
    ...(model ? { model } : {}),
  };
}

describe("provider errors and continued result delivery", () => {
  let scenario: PiAgentScenario;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    scenario = await createPiAgentScenario();
  });
  afterEach(async () => { await scenario.dispose(); });

  it("delivers a setup-complete provider error immediately and only once", async () => {
    scenario.store.mutate.routing.clearAll();
    scenario.providers[0].setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "quota exhausted" })]);

    await executeAgentTool("error", params("provider error"), undefined, undefined, scenario.ctx);
    const record = scenario.manager.listAgents()[0];
    await record.execution.promise;

    expect(record).toMatchObject({
      lifecycle: { status: "error", resultPersisted: true },
      execution: { settled: true },
      error: "quota exhausted",
    });
    expect(readResultEntries(scenario.ctx).pending.size).toBe(1);
    expect(scenario.pi.sendMessage).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(31 * 60_000);

    expect(scenario.manager.getRecord(record.id)).toBeUndefined();
    expect(readResultEntries(scenario.ctx).pending.size).toBe(1);
    expect(scenario.parent.getEntries().filter((entry: any) => entry.customType === "subagents-lite:pending-result")).toHaveLength(1);
    expect(scenario.pi.sendMessage).toHaveBeenCalledOnce();
    expect(scenario.createAgentSession).toHaveBeenCalledOnce();
  });

  it("delivers one terminal error after Pi exhausts transient retries", async () => {
    scenario.store.mutate.routing.clearAll();
    scenario.providers[0].setResponses(Array.from({ length: 3 }, () =>
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "stream_read_error: response closed" })));

    await executeAgentTool("retry", params("retry exhaustion"), undefined, undefined, scenario.ctx);
    const record = scenario.manager.listAgents()[0];
    await record.execution.promise;

    expect(scenario.providers[0].state.callCount).toBe(3);
    expect(record.lifecycle.status).toBe("error");
    expect(record.error).toBe("stream_read_error: response closed");
    expect(scenario.createAgentSession).toHaveBeenCalledOnce();
    expect(scenario.parent.getEntries().filter((entry: any) => entry.customType === "subagents-lite:pending-result")).toHaveLength(1);
    expect(readResultEntries(scenario.ctx).pending.size).toBe(1);
    expect(scenario.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it("shuts down a real Pi session when setup fails before extension binding", async () => {
    const create = scenario.createAgentSession.getMockImplementation()!;
    let child!: Awaited<ReturnType<typeof create>>["session"];
    scenario.createAgentSession.mockImplementationOnce(async options => {
      const result = await create(options);
      child = result.session;
      vi.spyOn(child, "bindExtensions").mockRejectedValueOnce(new Error("Extension setup failed"));
      vi.spyOn(child.extensionRunner, "emit");
      vi.spyOn(child, "dispose");
      return result;
    });
    await executeAgentTool("setup-error", params("setup failure"), undefined, undefined, scenario.ctx);
    const record = scenario.manager.listAgents()[0];
    await record.execution.promise;

    expect(record.lifecycle.status).toBe("error");
    expect(record.error).toBe("Extension setup failed");
    expect(record.execution.session).toBeUndefined();
    expect(child.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    expect(child.dispose).toHaveBeenCalledOnce();
    expect(scenario.providers[0].state.callCount).toBe(0);
    expect(readResultEntries(scenario.ctx).pending.size).toBe(1);
  });

  it("continues a delivered Error without replacing its first delivery", async () => {
    scenario.store.mutate.routing.clearAll();
    scenario.providers[0].setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "content_filter" }),
      fauxAssistantMessage("continued result"),
    ]);

    await executeAgentTool("error", params("continuable error"), undefined, undefined, scenario.ctx);
    const record = scenario.manager.listAgents()[0];
    await record.execution.promise;
    const firstDeliveryId = record.execution.resultDeliveryId;

    expect(record.lifecycle.status).toBe("error");
    expect(readResultEntries(scenario.ctx).pending.get(firstDeliveryId!)?.error).toBe("content_filter");
    await expect(scenario.coordinator.interact(record.id, "continue")).resolves.toEqual({ accepted: true });
    await record.execution.promise;
    const deliveredSelection = scenario.coordinator.deliverSelectedMessages(
      record.id, scenario.coordinator.getDeliverableMessages(record.id).filter((_, index) => [0].includes(index)),
    );
    expect(deliveredSelection.status).toBe("saved");
    if (deliveredSelection.status === "rejected") throw new Error("Selection was rejected");
    const delivered = deliveredSelection.delivery;
    expect(delivered).toBeDefined();
    const secondDeliveryId = delivered!.deliveryId;

    expect(secondDeliveryId).not.toBe(firstDeliveryId);
    expect(record.lifecycle.status).toBe("completed");
    expect(readResultEntries(scenario.ctx).pending.size).toBe(2);
    expect(scenario.parent.getEntries().filter((entry: any) =>
      entry.customType === "subagents-lite:pending-result"
      && entry.data.deliveryId === firstDeliveryId,
    )).toHaveLength(1);

    scenario.persistMessages();
    scenario.coordinator.onParentAgentEnd();
    await scenario.coordinator.onParentSettled();
    await Promise.resolve();

    const firstAck = scenario.parent.getEntries().find((entry: any) =>
      entry.customType === "subagents-lite:result-ack"
      && entry.data.deliveryIds.includes(firstDeliveryId),
    );
    expect(firstAck).toMatchObject({ type: "custom", data: { deliveryIds: [firstDeliveryId] } });
    expect(readResultEntries(scenario.ctx).pending.has(secondDeliveryId)).toBe(true);
    expect(scenario.pi.sendMessage).toHaveBeenCalledTimes(2);

    scenario.persistMessages();
    scenario.coordinator.onParentAgentEnd();
    await scenario.coordinator.onParentSettled();
    expect(readResultEntries(scenario.ctx).pending.size).toBe(0);
    const acknowledgedIds = scenario.parent.getEntries()
      .filter((entry: any) => entry.customType === "subagents-lite:result-ack")
      .flatMap((entry: any) => entry.data.deliveryIds);
    expect(acknowledgedIds.filter((id: string) => id === firstDeliveryId)).toHaveLength(1);
    expect(acknowledgedIds.filter((id: string) => id === secondDeliveryId)).toHaveLength(1);
  });
});
