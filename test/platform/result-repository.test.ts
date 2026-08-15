import { describe, expect, it } from "vitest";
import {
  createPiResultRepository,
} from "../../src/platform/pi/result-repository.js";
import type { BackgroundResultRecord } from "../../src/modules/background-result-delivery/public.js";

function record(agentId: string, text: string, parentSessionId = "session-a"): BackgroundResultRecord {
  return {
    deliveryId: agentId,
    parentSessionId,
    originEntryId: "origin-a",
    agentId,
    type: "reviewer",
    status: "completed",
    result: text,
    error: null,
    createdAt: 1,
  };
}

function context(entries: unknown[], sessionId = "session-a") {
  return {
    sessionManager: {
      getEntries: () => entries,
      getSessionId: () => sessionId,
    },
  } as any;
}

function createPi(entries: unknown[], fail = false) {
  return {
    appendEntry(customType: string, data: unknown) {
      if (fail) throw new Error("append failed");
      entries.push({ type: "custom", customType, data });
    },
  } as any;
}

describe("Pi ResultRepository contract", () => {
  it("appends, reads, acknowledges, and reports atomic append failure", () => {
    const entries: unknown[] = [];
    const repository = createPiResultRepository(createPi(entries), context(entries));

    expect(repository.append(record("a", "A"))).toBe(true);
    expect(repository.append(record("b", "B"))).toBe(true);
    expect(repository.read().pending).toHaveLength(2);
    expect(repository.acknowledge("session-a", ["a"])).toBe(true);
    expect(repository.read().pending.map((item) => item.deliveryId)).toEqual(["b"]);
    expect(repository.read().latest.find((item) => item.agentId === "a")).toMatchObject({
      result: "A",
      error: null,
    });
    expect(repository.find({ agentId: "a" })?.result).toBe("A");

    const failing = createPiResultRepository(createPi(entries, true), context(entries));
    expect(failing.append(record("c", "C"))).toBe(false);
    expect(repository.read().pending.map((item) => item.deliveryId)).toEqual(["b"]);
  });

  it("normalizes an empty persisted error instead of dropping the result", () => {
    const entry = {
      type: "custom",
      customType: "subagents-lite:pending-result",
      data: { ...record("a", "Agent failed: unknown error"), status: "error", error: "" },
    };
    const repository = createPiResultRepository(createPi([]), context([entry]));
    expect(repository.read().pending).toMatchObject([{ status: "error", error: null }]);
  });

  it("ignores incomplete result entries", () => {
    const entries = [
      { type: "custom", customType: "subagents-lite:pending-result", data: { agentId: "a", result: "A" } },
    ];
    const repository = createPiResultRepository(createPi([]), context(entries));
    expect(repository.read().pending).toEqual([]);
  });

  it("does not let an old delivery ack remove a newer continuation result", () => {
    const entries = [
      { type: "custom", customType: "subagents-lite:pending-result", data: { ...record("a", "first"), deliveryId: "a-1" } },
      { type: "custom", customType: "subagents-lite:result-ack", data: { parentSessionId: "session-a", deliveryIds: ["a-1"] } },
      { type: "custom", customType: "subagents-lite:pending-result", data: { ...record("a", "second"), deliveryId: "a-2" } },
    ];
    const repository = createPiResultRepository(createPi([]), context(entries));
    const read = repository.read();
    expect(read.pending).toMatchObject([{ deliveryId: "a-2", result: "second" }]);
    expect(read.latest).toMatchObject([{ deliveryId: "a-2" }]);
  });

  it("keeps the newest completion when an older result is persisted later", () => {
    const newer = { ...record("a", "newer"), deliveryId: "a-2", createdAt: 2 };
    const older = { ...record("a", "older"), deliveryId: "a-1", createdAt: 1 };
    const entries = [
      { type: "custom", customType: "subagents-lite:pending-result", data: newer },
      { type: "custom", customType: "subagents-lite:pending-result", data: older },
    ];
    const repository = createPiResultRepository(createPi([]), context(entries));
    const read = repository.read();
    expect(read.latest).toMatchObject([{ deliveryId: "a-2", result: "newer" }]);
    expect(read.pending.map((item) => item.deliveryId)).toEqual(["a-2", "a-1"]);
    expect(repository.find({ agentId: "a" })).toMatchObject({
      deliveryId: "a-2",
      result: "newer",
    });
    expect(repository.find({ agentId: "a", deliveryId: "a-1" })).toMatchObject({
      deliveryId: "a-1",
      result: "older",
    });
  });

  it("ignores pending results and acknowledgements copied from another session", () => {
    const entries = [
      { type: "custom", customType: "subagents-lite:pending-result", data: record("old", "old", "session-old") },
      { type: "custom", customType: "subagents-lite:pending-result", data: record("new", "new") },
      { type: "custom", customType: "subagents-lite:result-ack", data: { parentSessionId: "session-old", deliveryIds: ["new"] } },
    ];
    const repository = createPiResultRepository(createPi([]), context(entries));
    const read = repository.read();
    expect(read.pending.map((item) => item.deliveryId)).toEqual(["new"]);
    expect(read.latest.map((item) => item.agentId)).toEqual(["new"]);
    expect(repository.find({ agentId: "old" })).toBeUndefined();
  });

  it("reports atomic acknowledge failure without writing an ack entry", () => {
    const entries: unknown[] = [];
    const repository = createPiResultRepository(createPi(entries), context(entries));
    expect(repository.append(record("a", "A"))).toBe(true);
    const failing = createPiResultRepository(createPi(entries, true), context(entries));
    expect(failing.acknowledge("session-a", ["a"])).toBe(false);
    expect(repository.read().pending).toHaveLength(1);
  });
});
