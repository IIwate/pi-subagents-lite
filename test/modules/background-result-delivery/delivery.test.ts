import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  DeliveryCommandResultSchema,
  DeliveryEventSchema,
  createBackgroundDelivery,
  type BackgroundResultRecord,
  type DeliveryCommandResult,
  type DeliveryFallbackStore,
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

function roundTrip(result: DeliveryCommandResult): DeliveryCommandResult {
  return JSON.parse(JSON.stringify(result)) as DeliveryCommandResult;
}

function createMemory(options?: {
  appendFails?: boolean;
  sessionId?: string;
  branch?: () => string[];
  fallback?: DeliveryFallbackStore;
  pending?: BackgroundResultRecord[];
  latest?: BackgroundResultRecord[];
}) {
  const pending: BackgroundResultRecord[] = [...(options?.pending ?? [])];
  const latest: BackgroundResultRecord[] = [...(options?.latest ?? [])];
  const sent: Array<{ mode: "turn" | "follow-up"; content: string }> = [];
  const fallbackRecords: BackgroundResultRecord[] = [];
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
      parentSessionId: () => options?.sessionId ?? "session-a",
      activeBranchIds: () => options?.branch?.() ?? ["origin-a"],
      isIdle: () => true,
    },
    fallback: options?.fallback ?? {
      take: () => fallbackRecords.splice(0),
      save(_id, records) { fallbackRecords.splice(0, fallbackRecords.length, ...records); },
    },
  });
  return { delivery, sent, pending, fallbackRecords };
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
    expect(Check(DeliveryCommandResultSchema, roundTrip(result))).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        pending: [{ deliveryId: "d1", result: "done" }],
        lastWakeFailed: false,
      },
      events: [
        { type: "persisted", deliveryId: "d1" },
        { type: "wake-requested", deliveryIds: ["d1"], mode: "turn" },
      ],
    });
    expect(memory.sent).toEqual([
      { mode: "turn", content: expect.stringContaining("done") },
    ]);
    expect(memory.pending).toHaveLength(1);
  });
});

describe("REQ-DELIVERY-001 repository failure", () => {
  it("keeps the result in fallback and does not wake when append fails", () => {
    const memory = createMemory({ appendFails: true });
    const result = memory.delivery.execute({
      kind: "record-terminal",
      record: record(),
      stillPresent: true,
    });

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        fallback: [{ deliveryId: "d1" }],
        pending: [],
        lastWakeFailed: true,
      },
      events: [{ type: "fallback-retained", deliveryId: "d1" }],
    });
    expect(memory.sent).toEqual([]);
    expect(memory.pending).toHaveLength(0);
  });
});

describe("REQ-DELIVERY-002 origin-branch eligibility", () => {
  it("hides a result whose origin is not on the active branch", () => {
    const memory = createMemory();
    const result = memory.delivery.execute({
      kind: "record-terminal",
      record: record({ originEntryId: "other-branch" }),
      stillPresent: true,
    });

    expect(memory.delivery.pendingResultCount()).toBeUndefined();
    expect(result).toMatchObject({
      ok: true,
      events: [
        { type: "persisted", deliveryId: "d1" },
        { type: "hidden", deliveryId: "d1" },
      ],
    });
    const inspect = memory.delivery.execute({ kind: "inspect" });
    expect(inspect.ok && inspect.snapshot.pending[0]?.originEntryId).toBe("other-branch");
  });
});

describe("REQ-DELIVERY-003 coalesced wake and failed-turn recovery", () => {
  it("does not send a second wake while one is already active", () => {
    const memory = createMemory();
    memory.delivery.execute({
      kind: "record-terminal",
      record: record({ deliveryId: "d1", agentId: "a1" }),
      stillPresent: true,
    });
    const second = memory.delivery.execute({
      kind: "record-terminal",
      record: record({ deliveryId: "d2", agentId: "a2", result: "second" }),
      stillPresent: true,
    });
    expect(memory.sent).toHaveLength(1);
    expect(second).toMatchObject({
      ok: true,
      events: [{ type: "persisted", deliveryId: "d2" }],
    });
  });

  it("lets a later completion wake after a failed parent turn", () => {
    const memory = createMemory();
    memory.delivery.execute({
      kind: "record-terminal",
      record: record({ deliveryId: "d1" }),
      stillPresent: true,
    });
    memory.delivery.execute({ kind: "parent-end", succeeded: false });
    memory.delivery.execute({ kind: "parent-settled" });
    expect(memory.sent).toHaveLength(1);

    const later = memory.delivery.execute({
      kind: "record-terminal",
      record: record({ deliveryId: "d2", agentId: "a2", result: "later" }),
      stillPresent: true,
    });
    expect(memory.sent).toHaveLength(2);
    expect(memory.sent[1]?.content).toContain("later");
    expect(later).toMatchObject({
      ok: true,
      events: [
        { type: "persisted", deliveryId: "d2" },
        { type: "wake-requested", deliveryIds: ["d1", "d2"], mode: "turn" },
      ],
    });
  });
});

describe("REQ-DELIVERY-004 acknowledgement after successful settlement", () => {
  it("acknowledges presented results only after a successful parent settle", () => {
    const memory = createMemory();
    memory.delivery.execute({
      kind: "record-terminal",
      record: record(),
      stillPresent: true,
    });
    memory.delivery.execute({ kind: "mark-presented", deliveryId: "d1" });
    memory.delivery.execute({ kind: "parent-end", succeeded: true });
    const settled = memory.delivery.execute({ kind: "parent-settled" });
    expect(settled).toMatchObject({
      ok: true,
      snapshot: { pending: [] },
      events: [{ type: "acknowledged", deliveryIds: ["d1"] }],
    });
  });
});

describe("REQ-DELIVERY-004 preflight injection", () => {
  it("returns a preflight injection for eligible pending results", () => {
    const memory = createMemory();
    memory.delivery.execute({
      kind: "record-terminal",
      record: record(),
      stillPresent: true,
    });
    const preflight = memory.delivery.execute({ kind: "parent-preflight" });
    expect(preflight.ok && preflight.injection?.content).toContain("done");
    expect(preflight).toMatchObject({
      ok: true,
      events: [{ type: "injected", deliveryIds: ["d1"] }],
    });
    expect(Check(DeliveryEventSchema, preflight.ok && preflight.events[0])).toBe(true);
  });
});

describe("REQ-DELIVERY-005 restore and tree navigation", () => {
  it("wakes a previously hidden result after session-tree makes its origin active", () => {
    let branch = ["origin-a"];
    const sent: Array<{ mode: "turn" | "follow-up"; content: string }> = [];
    const pending: BackgroundResultRecord[] = [];
    const delivery = createBackgroundDelivery({
      repository: {
        read: () => ({ pending: [], latest: [] }),
        append(next) { pending.push(next); return true; },
        acknowledge: () => true,
      },
      messenger: {
        send(message, mode) {
          sent.push({ mode, content: message.content });
          return true;
        },
      },
      context: {
        parentSessionId: () => "session-a",
        activeBranchIds: () => branch,
        isIdle: () => true,
      },
      fallback: { take: () => [], save() {} },
    });
    delivery.execute({
      kind: "record-terminal",
      record: record({ originEntryId: "origin-b" }),
      stillPresent: true,
    });
    expect(delivery.pendingResultCount()).toBeUndefined();
    expect(sent).toEqual([]);
    branch = ["origin-b"];
    const tree = delivery.execute({ kind: "session-tree" });
    expect(tree).toMatchObject({
      ok: true,
      events: [
        { type: "restored", deliveryIds: ["d1"] },
        { type: "wake-requested", deliveryIds: ["d1"], mode: "turn" },
      ],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.content).toContain("done");
  });

  it("re-arms restored Auto pending on explicit session reload", () => {
    const pending = [record()];
    const memory = createMemory({ pending, latest: pending });
    expect(memory.sent).toEqual([]);
    const restored = memory.delivery.execute({ kind: "restore" });
    expect(restored).toMatchObject({
      ok: true,
      events: [
        { type: "restored", deliveryIds: ["d1"] },
        { type: "wake-requested", deliveryIds: ["d1"], mode: "turn" },
      ],
    });
    expect(memory.sent).toHaveLength(1);
    expect(memory.sent[0]?.content).toContain("done");
  });

  it("does not wake a restored result from another parent session", () => {
    const memory = createMemory();
    memory.delivery.execute({
      kind: "record-terminal",
      record: record({ parentSessionId: "session-b" }),
      stillPresent: true,
    });
    const restored = memory.delivery.execute({ kind: "restore" });
    expect(memory.sent).toEqual([]);
    expect(restored).toMatchObject({
      ok: true,
      events: [],
    });
  });

  it("isolates session-keyed fallback buckets", () => {
    const buckets = new Map<string, BackgroundResultRecord[]>();
    const fallback: DeliveryFallbackStore = {
      take(sessionId) {
        const items = buckets.get(sessionId) ?? [];
        buckets.delete(sessionId);
        return items;
      },
      save(sessionId, records) {
        if (records.length > 0) buckets.set(sessionId, [...records]);
        else buckets.delete(sessionId);
      },
    };
    const first = createMemory({ appendFails: true, fallback });
    first.delivery.execute({
      kind: "record-terminal",
      record: record(),
      stillPresent: true,
    });
    first.delivery.execute({ kind: "dispose" });
    expect(buckets.get("session-a")).toHaveLength(1);

    const other = createMemory({ sessionId: "session-b", fallback });
    const isolated = other.delivery.execute({ kind: "restore" });
    expect(isolated).toMatchObject({ ok: true, events: [] });
    expect(other.sent).toEqual([]);
    expect(buckets.get("session-a")).toHaveLength(1);
  });

  it("prefers a persisted completion over a same-timestamp fallback for the same agent", () => {
    const delivery = createBackgroundDelivery({
      repository: {
        read: () => ({ pending: [], latest: [] }),
        append(next) {
          return next.result !== "older fallback";
        },
        acknowledge: () => true,
      },
      messenger: { send: () => true },
      context: {
        parentSessionId: () => "session-a",
        activeBranchIds: () => ["origin-a"],
        isIdle: () => true,
      },
      fallback: { take: () => [], save() {} },
    });
    delivery.execute({
      kind: "record-terminal",
      record: record({ deliveryId: "old", result: "older fallback", createdAt: 1 }),
      stillPresent: true,
    });
    delivery.execute({
      kind: "record-terminal",
      record: record({ deliveryId: "new", result: "current result", createdAt: 1 }),
      stillPresent: true,
    });
    expect(delivery.getStoredResult("agent-1")).toMatchObject({
      deliveryId: "new",
      result: "current result",
    });
  });

  it("rejects a malformed command at the public seam", () => {
    const memory = createMemory();
    expect(memory.delivery.execute({ kind: "not-a-command" })).toEqual({
      ok: false,
      error: { code: "invalid-command", message: "Delivery command is invalid." },
    });
  });
});
