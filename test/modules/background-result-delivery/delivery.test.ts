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
  const acknowledged: string[][] = [];
  const fallbackRecords: BackgroundResultRecord[] = [];
  const repository: ResultRepository = {
    read: () => ({ pending: [...pending], latest: [...latest] }),
    find(query) {
      return latest
        .filter((item) => item.agentId === query.agentId)
        .filter((item) => !query.deliveryId || item.deliveryId === query.deliveryId)
        .reduce<BackgroundResultRecord | undefined>(
          (newest, item) => !newest || item.createdAt >= newest.createdAt ? item : newest,
          undefined,
        );
    },
    append(next) {
      if (options?.appendFails) return false;
      pending.push(next);
      latest.push(next);
      return true;
    },
    acknowledge(_sessionId, ids) {
      acknowledged.push([...ids]);
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
  return { delivery, sent, pending, latest, fallbackRecords, acknowledged };
}

describe("REQ-DELIVERY-001 persist before wake", () => {
  it.each(["queued", "running"])("rejects a nonterminal %s record before persistence", (status) => {
    const memory = createMemory();
    const result = memory.delivery.execute({
      kind: "record-terminal",
      record: record({ status: status as BackgroundResultRecord["status"] }),
      stillPresent: true,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "invalid-command", message: "Delivery record must have a terminal status." },
    });
    expect(memory.pending).toEqual([]);
    expect(memory.sent).toEqual([]);
  });

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

  it("delivers a result whose origin entry appeared after the last branch read", () => {
    // The host still reports the branch as it was when the turn started; the
    // Agent call created "leaf-new" inside that turn.
    const memory = createMemory({ branch: () => ["origin-a"] });
    memory.delivery.execute({ kind: "track-origin", originEntryId: "leaf-new" });

    const result = memory.delivery.execute({
      kind: "record-terminal",
      record: record({ originEntryId: "leaf-new" }),
      stillPresent: true,
    });

    expect(result).toMatchObject({
      ok: true,
      events: [
        { type: "persisted", deliveryId: "d1" },
        { type: "wake-requested", deliveryIds: ["d1"], mode: "turn" },
      ],
    });
    expect(memory.sent).toEqual([
      { mode: "turn", content: expect.stringContaining("done") },
    ]);
  });

  it("delivers after parent-preflight when the host still omits the tracked origin", () => {
    const memory = createMemory({ branch: () => ["origin-a"] });
    memory.delivery.execute({ kind: "track-origin", originEntryId: "leaf-new" });
    memory.delivery.execute({ kind: "parent-preflight" });

    const recorded = memory.delivery.execute({
      kind: "record-terminal",
      record: record({ originEntryId: "leaf-new" }),
      stillPresent: true,
    });
    expect(recorded).toMatchObject({
      ok: true,
      events: [{ type: "persisted", deliveryId: "d1" }],
    });
    expect(recorded.ok && recorded.events.some((event) => event.type === "hidden")).toBe(false);

    // Preflight holds wake until the parent run starts; eligibility must
    // still be intact so agent_start can present the result.
    const started = memory.delivery.execute({ kind: "parent-start" });
    expect(started).toMatchObject({
      ok: true,
      events: [{ type: "wake-requested", deliveryIds: ["d1"], mode: "follow-up" }],
    });
    expect(memory.sent).toEqual([
      { mode: "follow-up", content: expect.stringContaining("done") },
    ]);
  });

  it("delivers after restore when the host still omits the tracked origin", () => {
    const memory = createMemory({ branch: () => ["origin-a"] });
    memory.delivery.execute({ kind: "track-origin", originEntryId: "leaf-new" });
    memory.delivery.execute({ kind: "restore" });

    const result = memory.delivery.execute({
      kind: "record-terminal",
      record: record({ originEntryId: "leaf-new" }),
      stillPresent: true,
    });

    expect(result).toMatchObject({
      ok: true,
      events: [
        { type: "persisted", deliveryId: "d1" },
        { type: "wake-requested", deliveryIds: ["d1"], mode: "turn" },
      ],
    });
    expect(memory.sent).toEqual([
      { mode: "turn", content: expect.stringContaining("done") },
    ]);
  });

  it("drops a tracked origin once the host reports a branch without it", () => {
    const memory = createMemory({ branch: () => ["origin-a"] });
    memory.delivery.execute({ kind: "track-origin", originEntryId: "leaf-new" });
    memory.delivery.execute({ kind: "session-tree" });

    const result = memory.delivery.execute({
      kind: "record-terminal",
      record: record({ originEntryId: "leaf-new" }),
      stillPresent: true,
    });

    expect(result).toMatchObject({
      ok: true,
      events: [
        { type: "persisted", deliveryId: "d1" },
        { type: "hidden", deliveryId: "d1" },
      ],
    });
    expect(memory.sent).toEqual([]);
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

  it("persists the full result while the parent wake injection is truncated", () => {
    const body = `${"w".repeat(4000)}!`;
    const memory = createMemory();
    const recorded = memory.delivery.execute({
      kind: "record-terminal",
      record: record({ result: body }),
      stillPresent: true,
    });

    expect(recorded.ok && recorded.snapshot.pending[0]?.result).toBe(body);
    expect(memory.pending[0]?.result).toBe(body);
    const inspected = memory.delivery.execute({ kind: "inspect", agentId: "agent-1" });
    expect(inspected.ok && inspected.stored?.result).toBe(body);
    expect(memory.sent[0]?.content).toContain("w".repeat(4000));
    expect(memory.sent[0]?.content).not.toContain(body);
    expect(memory.sent[0]?.content).toContain('AgentStatus({ agent_id: "agent-1" })');
  });

  it("truncates each preflight result independently and leaves persisted records intact", () => {
    const first = `${"a".repeat(4000)}X`;
    const second = `${"b".repeat(4000)}Y`;
    const pending = [
      record({ deliveryId: "d1", agentId: "a1", result: first }),
      record({ deliveryId: "d2", agentId: "a2", result: second }),
    ];
    const memory = createMemory({ pending, latest: pending });
    const preflight = memory.delivery.execute({ kind: "parent-preflight" });

    expect(preflight.ok && preflight.snapshot.pending.map((item) => item.result)).toEqual([first, second]);
    expect(preflight.ok && preflight.injection?.content).toContain("a".repeat(4000));
    expect(preflight.ok && preflight.injection?.content).toContain("b".repeat(4000));
    expect(preflight.ok && preflight.injection?.content).not.toContain(first);
    expect(preflight.ok && preflight.injection?.content).not.toContain(second);
    expect(preflight.ok && preflight.injection?.content).toContain('AgentStatus({ agent_id: "a1" })');
    expect(preflight.ok && preflight.injection?.content).toContain('AgentStatus({ agent_id: "a2" })');

    const inspect = memory.delivery.execute({ kind: "inspect", agentId: "a1" });
    expect(inspect.ok && inspect.stored?.result).toBe(first);
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
        find: () => undefined,
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
        find(query) {
          return query.agentId === "agent-1"
            ? record({ deliveryId: "new", result: "current result", createdAt: 1 })
            : undefined;
        },
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
    const inspected = delivery.execute({ kind: "inspect", agentId: "agent-1" });
    expect(inspected.ok && inspected.stored).toMatchObject({
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

  it("refuses an inspect result whose host context produces an off-contract snapshot", () => {
    const delivery = createBackgroundDelivery({
      repository: {
        read: () => ({ pending: [], latest: [] }),
        find: () => undefined,
        append: () => true,
        acknowledge: () => true,
      },
      messenger: { send: () => true },
      context: {
        parentSessionId: () => null as unknown as string,
        activeBranchIds: () => [],
        isIdle: () => true,
      },
      fallback: { take: () => [], save() {} },
    });
    const result = delivery.execute({ kind: "inspect" });
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid-command", message: "Delivery result does not match its contract." },
    });
    expect(Check(DeliveryCommandResultSchema, result)).toBe(true);
  });

  it("rereads a durable result written after delivery construction", () => {
    const memory = createMemory();
    memory.latest.push(record({
      deliveryId: "late",
      result: "written by another runtime",
      createdAt: 2,
    }));

    const inspected = memory.delivery.execute({ kind: "inspect", agentId: "agent-1" });

    expect(inspected.ok && inspected.stored).toMatchObject({
      deliveryId: "late",
      result: "written by another runtime",
    });
  });

  it("hydrates a durable-only exact inspect before successful settlement acknowledgement", () => {
    const durable = record({ deliveryId: "reload-only" });
    const memory = createMemory({ latest: [durable] });
    const inspected = memory.delivery.execute({
      kind: "inspect",
      agentId: durable.agentId,
      deliveryId: durable.deliveryId,
    });
    expect(inspected.ok && inspected.stored?.deliveryId).toBe("reload-only");

    memory.delivery.execute({ kind: "mark-presented", deliveryId: durable.deliveryId });
    memory.delivery.execute({ kind: "parent-end", succeeded: true });
    const settled = memory.delivery.execute({ kind: "parent-settled" });

    expect(settled).toMatchObject({
      ok: true,
      events: [{ type: "acknowledged", deliveryIds: ["reload-only"] }],
    });
    expect(memory.acknowledged).toEqual([["reload-only"]]);
  });

  it("does not inspect or acknowledge a foreign-session durable result", () => {
    const memory = createMemory();
    memory.latest.push(record({ deliveryId: "foreign", parentSessionId: "session-b" }));

    const inspected = memory.delivery.execute({
      kind: "inspect",
      agentId: "agent-1",
      deliveryId: "foreign",
    });
    expect(inspected.ok && inspected.stored).toBeUndefined();

    memory.delivery.execute({ kind: "mark-presented", deliveryId: "foreign" });
    memory.delivery.execute({ kind: "parent-end", succeeded: true });
    memory.delivery.execute({ kind: "parent-settled" });
    expect(memory.acknowledged).toEqual([]);
  });

  it("prefers a later durable continuation over the construction snapshot", () => {
    const old = record({ deliveryId: "old", result: "old result", createdAt: 1 });
    const memory = createMemory({ latest: [old] });
    memory.latest.push(record({
      deliveryId: "new",
      result: "new result",
      createdAt: 2,
    }));

    const latest = memory.delivery.execute({ kind: "inspect", agentId: "agent-1" });
    const exact = memory.delivery.execute({
      kind: "inspect",
      agentId: "agent-1",
      deliveryId: "old",
    });

    expect(latest.ok && latest.stored).toMatchObject({ deliveryId: "new", result: "new result" });
    expect(exact.ok && exact.stored).toMatchObject({ deliveryId: "old", result: "old result" });
  });

  it("drops off-contract records read from the repository and the fallback inbox", () => {
    const stale = { deliveryId: "stale", parentSessionId: "session-a", status: "finished" };
    const memory = createMemory({
      pending: [record({ deliveryId: "kept" }), stale as unknown as BackgroundResultRecord],
      fallback: {
        take: () => [
          record({ deliveryId: "fallback-kept", originEntryId: "origin-a" }),
          { ...record({ deliveryId: "fallback-stale" }), createdAt: "yesterday" } as unknown as BackgroundResultRecord,
        ],
        save() {},
      },
    });

    const result = memory.delivery.execute({ kind: "parent-preflight" });

    expect(result.ok).toBe(true);
    expect(Check(DeliveryCommandResultSchema, result)).toBe(true);
    if (!result.ok) return;
    // Preflight flushes the surviving fallback record into the repository, so
    // the contract to pin is which records survived at all, not their bucket.
    expect(result.snapshot.pending.map((item) => item.deliveryId)).toEqual(["kept", "fallback-kept"]);
    expect(result.snapshot.fallback).toEqual([]);
  });
});
