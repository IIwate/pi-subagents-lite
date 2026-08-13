import { describe, expect, it } from "vitest";
import type {
  BackgroundResultRecord,
  ResultRepository,
} from "../../../src/modules/background-result-delivery/public.js";

function record(id: string, overrides: Partial<BackgroundResultRecord> = {}): BackgroundResultRecord {
  return {
    deliveryId: id,
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

function createMemoryRepository(): ResultRepository & {
  failNextAppend: boolean;
  failNextAck: boolean;
} {
  const pending: BackgroundResultRecord[] = [];
  const latest: BackgroundResultRecord[] = [];
  return {
    failNextAppend: false,
    failNextAck: false,
    read: () => ({ pending: [...pending], latest: [...latest] }),
    append(next) {
      if (this.failNextAppend) return false;
      pending.push(next);
      const current = latest.findIndex((item) => item.agentId === next.agentId);
      if (current >= 0) {
        if (next.createdAt >= latest[current]!.createdAt) latest[current] = next;
      } else {
        latest.push(next);
      }
      return true;
    },
    acknowledge(_sessionId, ids) {
      if (this.failNextAck) return false;
      for (const id of ids) {
        const index = pending.findIndex((item) => item.deliveryId === id);
        if (index >= 0) pending.splice(index, 1);
      }
      return true;
    },
  };
}

describe("ResultRepository in-memory contract", () => {
  it("appends, reads, acknowledges, and reports atomic append failure", () => {
    const repository = createMemoryRepository();
    expect(repository.append(record("d1"))).toBe(true);
    expect(repository.read().pending).toEqual([record("d1")]);
    expect(repository.read().latest).toEqual([record("d1")]);
    expect(repository.acknowledge("session-a", ["d1"])).toBe(true);
    expect(repository.read().pending).toEqual([]);
    expect(repository.read().latest).toEqual([record("d1")]);

    repository.failNextAppend = true;
    expect(repository.append(record("d2"))).toBe(false);
    expect(repository.read().pending).toEqual([]);
  });

  it("reports atomic acknowledge failure without dropping the pending record", () => {
    const repository = createMemoryRepository();
    expect(repository.append(record("d1"))).toBe(true);
    repository.failNextAck = true;
    expect(repository.acknowledge("session-a", ["d1"])).toBe(false);
    expect(repository.read().pending).toEqual([record("d1")]);
  });
});
