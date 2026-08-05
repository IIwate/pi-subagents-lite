import { describe, expect, it, vi } from "vitest";
import {
  appendPendingResult,
  appendResultAck,
  buildResultMessage,
  findStoredResult,
  readResultEntries,
} from "../../src/spawn/result-inbox.js";

function result(agentId: string, text: string, parentSessionId = "session-a") {
  return {
    deliveryId: agentId,
    parentSessionId,
    originEntryId: "origin-a",
    agentId,
    type: "reviewer",
    status: "completed" as const,
    result: text,
    error: null,
    createdAt: 1,
  };
}

function context(entries: any[], sessionId = "session-a") {
  return {
    sessionManager: {
      getEntries: () => entries,
      getSessionId: () => sessionId,
    },
  } as any;
}

describe("result inbox", () => {
  it("persists pending results and removes only acknowledged IDs", () => {
    const entries: any[] = [];
    const pi = {
      appendEntry: vi.fn((customType: string, data: unknown) => entries.push({ type: "custom", customType, data })),
    } as any;

    expect(appendPendingResult(pi, result("a", "A"))).toBe(true);
    expect(appendPendingResult(pi, result("b", "B"))).toBe(true);
    const ctx = context(entries);

    expect(readResultEntries(ctx).pending.size).toBe(2);
    expect(appendResultAck(pi, "session-a", ["a"])).toBe(true);
    expect([...readResultEntries(ctx).pending.keys()]).toEqual(["b"]);
    expect(findStoredResult(ctx, "a")).toMatchObject({ result: "A", error: null });
  });

  it("normalizes an empty persisted error instead of dropping the result", () => {
    const entry = {
      type: "custom",
      customType: "subagents-lite:pending-result",
      data: { ...result("a", "Agent failed: unknown error"), status: "error", error: "" },
    };

    expect(readResultEntries(context([entry])).pending.get("a"))
      .toMatchObject({ status: "error", error: null });
  });

  it("ignores incomplete result entries", () => {
    const entries = [
      { type: "custom", customType: "subagents-lite:pending-result", data: { agentId: "a", result: "A" } },
    ];

    expect(readResultEntries(context(entries)).pending.size).toBe(0);
  });

  it("does not let an old delivery ack remove a newer continuation result", () => {
    const entries = [
      { type: "custom", customType: "subagents-lite:pending-result", data: { ...result("a", "first"), deliveryId: "a-1" } },
      { type: "custom", customType: "subagents-lite:result-ack", data: { parentSessionId: "session-a", deliveryIds: ["a-1"] } },
      { type: "custom", customType: "subagents-lite:pending-result", data: { ...result("a", "second"), deliveryId: "a-2" } },
    ];

    const read = readResultEntries(context(entries));
    expect(read.pending.get("a-2")?.result).toBe("second");
    expect(read.latest.get("a")?.deliveryId).toBe("a-2");
  });

  it("keeps the newest completion when an older result is persisted later", () => {
    const newer = { ...result("a", "newer"), deliveryId: "a-2", createdAt: 2 };
    const older = { ...result("a", "older"), deliveryId: "a-1", createdAt: 1 };
    const entries = [
      { type: "custom", customType: "subagents-lite:pending-result", data: newer },
      { type: "custom", customType: "subagents-lite:pending-result", data: older },
    ];

    const read = readResultEntries(context(entries));
    expect(read.latest.get("a")).toMatchObject({ deliveryId: "a-2", result: "newer" });
    expect([...read.pending.keys()]).toEqual(["a-2", "a-1"]);
  });

  it("ignores pending results and acknowledgements copied from another session", () => {
    const entries = [
      { type: "custom", customType: "subagents-lite:pending-result", data: result("old", "old", "session-old") },
      { type: "custom", customType: "subagents-lite:pending-result", data: result("new", "new") },
      { type: "custom", customType: "subagents-lite:result-ack", data: { parentSessionId: "session-old", deliveryIds: ["new"] } },
    ];

    const read = readResultEntries(context(entries));
    expect([...read.pending.keys()]).toEqual(["new"]);
    expect([...read.latest.keys()]).toEqual(["new"]);
  });

  it("aggregates current pending results into one hidden parent message", () => {
    const results = [result("a", "A"), result("b", "B")];
    const message = buildResultMessage(results)!;

    expect(message.customType).toBe("subagent-result");
    expect(message.display).toBe(false);
    expect(message.content).toContain('[Subagent "reviewer" a completed]');
    expect(message.content).toContain("A");
    expect(message.content).toContain("B");
  });
});
