import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  DeliveryCommandResultSchema,
  createBackgroundDelivery,
  type BackgroundResultRecord,
  type ParentMessenger,
  type ResultRepository,
} from "../../../src/modules/background-result-delivery/public.js";

function record(overrides: Partial<BackgroundResultRecord> = {}): BackgroundResultRecord {
  return {
    deliveryId: "d1",
    parentSessionId: "session-a",
    originEntryId: "origin-a",
    agentId: "agent-1",
    type: "reviewer",
    status: "completed",
    result: "done",
    error: null,
    createdAt: 1,
    ...overrides,
  };
}

function createMemory(options?: { appendFails?: boolean }) {
  const pending: BackgroundResultRecord[] = [];
  const latest: BackgroundResultRecord[] = [];
  const sent: Array<{ mode: "turn" | "follow-up"; content: string }> = [];
  const fallback: BackgroundResultRecord[] = [];
  const repository: ResultRepository = {
    read: () => ({ pending: [...pending], latest: [...latest] }),
    append(next) {
      if (options?.appendFails) return false;
      pending.push(next);
      latest.push(next);
      return true;
    },
    acknowledge(_sessionId, ids) {
      for (const id of ids) {
        const index = pending.findIndex((item) => item.deliveryId === id);
        if (index >= 0) pending.splice(index, 1);
      }
      return true;
    },
  };
  const messenger: ParentMessenger = {
    send(message, mode) {
      sent.push({ mode, content: message.content });
      return true;
    },
  };
  const delivery = createBackgroundDelivery({
    repository,
    messenger,
    context: {
      parentSessionId: () => "session-a",
      activeBranchIds: () => ["origin-a"],
      isIdle: () => true,
    },
    fallback: {
      take: () => fallback.splice(0),
      save(_id, records) { fallback.splice(0, fallback.length, ...records); },
    },
  });
  return { delivery, sent, pending };
}

describe("REQ-DELIVERY-001 persist before wake", () => {
  it("appends a terminal result then requests one parent wake", () => {
    const memory = createMemory();
    const result = memory.delivery.execute({
      kind: "record-terminal",
      record: record(),
      stillPresent: true,
    });

    expect(Check(DeliveryCommandResultSchema, result)).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        pending: [{ deliveryId: "d1", result: "done" }],
        lastWakeFailed: false,
      },
    });
    expect(memory.sent).toEqual([
      { mode: "turn", content: expect.stringContaining("done") },
    ]);
    expect(memory.pending).toHaveLength(1);
  });
});

describe("REQ-DELIVERY-002 origin-branch eligibility", () => {
  it("hides a result whose origin is not on the active branch", () => {
    const memory = createMemory();
    memory.delivery.execute({
      kind: "record-terminal",
      record: record({ originEntryId: "other-branch" }),
      stillPresent: true,
    });

    expect(memory.delivery.pendingResultCount()).toBeUndefined();
    const inspect = memory.delivery.execute({ kind: "inspect" });
    expect(inspect.ok && inspect.snapshot.pending[0]?.originEntryId).toBe("other-branch");
  });
});
