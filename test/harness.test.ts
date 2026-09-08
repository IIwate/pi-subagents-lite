import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { setFallbackResults, takeFallbackResults } from "../src/shell.js";
import type { PendingResult } from "../src/spawn/result-inbox.js";
import { createTestHarness } from "./harness.js";

describe("test resource ownership", () => {
  it("awaits teardown and completes cleanup after a failure without draining another session", async () => {
    const harness = createTestHarness();
    const other = createTestHarness();
    const directory = harness.createTempDir();
    const result: PendingResult = {
      deliveryId: "result", parentSessionId: harness.sessionId, originEntryId: null,
      agentId: "agent", type: "Explore", status: "completed", result: "Saved output", error: null, createdAt: 0,
    };
    const released = vi.fn();
    const gate = Promise.withResolvers<void>();
    const failure = new Error("session teardown failed");
    setFallbackResults(harness.sessionId, [result]);
    setFallbackResults(other.sessionId, [{ ...result, parentSessionId: other.sessionId }]);
    harness.onDispose(async () => { await gate.promise; released(); });
    harness.onDispose(() => { throw failure; });
    const cleanup = harness.dispose();
    const rejected = expect(cleanup).rejects.toMatchObject({ errors: [failure] });
    try {
      expect(existsSync(directory)).toBe(true);
      expect(released).not.toHaveBeenCalled();
      gate.resolve();
      await rejected;
      expect(released).toHaveBeenCalledOnce();
      expect(existsSync(directory)).toBe(false);
      expect(takeFallbackResults(harness.sessionId)).toEqual([]);
      expect(takeFallbackResults(other.sessionId)).toEqual([{ ...result, parentSessionId: other.sessionId }]);
      await expect(harness.dispose()).rejects.toMatchObject({ errors: [failure] });
      expect(released).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await cleanup.catch(() => {});
      await other.dispose();
    }
  });
});
