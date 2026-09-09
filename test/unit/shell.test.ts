import { afterEach, describe, expect, it } from "vitest";

const pendingResult = {
  deliveryId: "delivery-1",
  parentSessionId: "session-a",
  originEntryId: "origin-a",
  agentId: "agent-1",
  type: "reviewer",
  status: "completed" as const,
  result: "done",
  error: null,
  createdAt: 1,
};

describe("process-local fallback storage", () => {
  afterEach(async () => {
    const shell = await import("../../src/shell.js");
    shell.takeFallbackResults("session-a");
    shell.takeFallbackResults("session-b");
  });

  it("keeps another session's fallback until that session consumes it", async () => {
    const shell = await import("../../src/shell.js");
    shell.setFallbackResults("session-a", [pendingResult]);

    expect(shell.takeFallbackResults("session-b")).toEqual([]);
    expect(shell.takeFallbackResults("session-a")).toEqual([pendingResult]);
    expect(shell.takeFallbackResults("session-a")).toEqual([]);
  });

  it("stores fallback results for multiple sessions independently", async () => {
    const shell = await import("../../src/shell.js");
    const sessionBResult = {
      ...pendingResult,
      deliveryId: "delivery-2",
      parentSessionId: "session-b",
    };
    shell.setFallbackResults("session-a", [pendingResult]);
    shell.setFallbackResults("session-b", [sessionBResult]);

    expect(shell.takeFallbackResults("session-a")).toEqual([pendingResult]);
    shell.setFallbackResults("session-a", []);
    expect(shell.takeFallbackResults("session-b")).toEqual([sessionBResult]);
  });
});
