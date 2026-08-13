import path from "node:path";
import { createJiti } from "jiti";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  delivery: "auto" as const,
};

describe("process-state platform contract", () => {
  afterEach(async () => {
    const processState = await import("../../../src/platform/process/process-state.js");
    processState.takeFallbackResults("session-a");
    processState.takeFallbackResults("session-b");
  });

  it("keeps another session's fallback until that session consumes it", async () => {
    const processState = await import("../../../src/platform/process/process-state.js");
    processState.setFallbackResults("session-a", [pendingResult]);

    expect(processState.takeFallbackResults("session-b")).toEqual([]);
    expect(processState.takeFallbackResults("session-a")).toEqual([pendingResult]);
    expect(processState.takeFallbackResults("session-a")).toEqual([]);
  });

  it("stores fallback results for multiple sessions independently", async () => {
    const processState = await import("../../../src/platform/process/process-state.js");
    const sessionBResult = {
      ...pendingResult,
      deliveryId: "delivery-2",
      parentSessionId: "session-b",
    };
    processState.setFallbackResults("session-a", [pendingResult]);
    processState.setFallbackResults("session-b", [sessionBResult]);

    expect(processState.takeFallbackResults("session-a")).toEqual([pendingResult]);
    processState.setFallbackResults("session-a", []);
    expect(processState.takeFallbackResults("session-b")).toEqual([sessionBResult]);
  });

  it("keeps same-session fallback results across a module reload", async () => {
    const first = await import("../../../src/platform/process/process-state.js");
    first.setFallbackResults("session-a", [pendingResult]);

    vi.resetModules();
    const reloaded = await import("../../../src/platform/process/process-state.js");

    expect(reloaded.takeFallbackResults("session-a")).toEqual([pendingResult]);
  });

  // Four uncached Jiti imports compile the full module graph each time and can
  // exceed the default 5s budget on cold disks or loaded CI runners. The test
  // asserts state semantics across reloads, not performance, so give it room.
  it("keeps fallback and child context across Pi-style Jiti reloads", { timeout: 30_000 }, async () => {
    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const modulePath = path.resolve("src/platform/process/process-state.ts");
    const first = await jiti.import<typeof import("../../../src/platform/process/process-state.js")>(modulePath);
    first.setFallbackResults("session-a", [pendingResult]);

    const reloaded = await jiti.import<typeof import("../../../src/platform/process/process-state.js")>(modulePath);
    expect(reloaded.takeFallbackResults("session-a")).toEqual([pendingResult]);
    await first.withSubagentSpawn(async () => {
      const child = await jiti.import<typeof import("../../../src/platform/process/process-state.js")>(modulePath);
      expect(child.isInsideSubagentSpawn()).toBe(true);
    });
    const parent = await jiti.import<typeof import("../../../src/platform/process/process-state.js")>(modulePath);
    expect(parent.isInsideSubagentSpawn()).toBe(false);
  });

  it("keeps the child marker across reload only in the child async context", async () => {
    const first = await import("../../../src/platform/process/process-state.js");

    await first.withSubagentSpawn(async () => {
      vi.resetModules();
      const reloaded = await import("../../../src/platform/process/process-state.js");
      expect(reloaded.isInsideSubagentSpawn()).toBe(true);
    });

    const parent = await import("../../../src/platform/process/process-state.js");
    expect(parent.isInsideSubagentSpawn()).toBe(false);
  });
});
