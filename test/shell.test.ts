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

describe("process-local shell state", () => {
  afterEach(async () => {
    const shell = await import("../src/shell.js");
    shell.takeFallbackResults("session-a");
    shell.takeFallbackResults("session-b");
  });

  it("keeps same-session fallback results across a module reload", async () => {
    const first = await import("../src/shell.js");
    first.setFallbackResults("session-a", [pendingResult]);

    vi.resetModules();
    const reloaded = await import("../src/shell.js");

    expect(reloaded.takeFallbackResults("session-a")).toEqual([pendingResult]);
  });

  it("keeps fallback and child context across Pi-style Jiti reloads", async () => {
    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const shellPath = path.resolve("src/shell.ts");
    const first = await jiti.import<typeof import("../src/shell.js")>(shellPath);
    first.setFallbackResults("session-a", [pendingResult]);

    const reloaded = await jiti.import<typeof import("../src/shell.js")>(shellPath);
    expect(reloaded.takeFallbackResults("session-a")).toEqual([pendingResult]);
    await first.withSubagentSpawn(async () => {
      const child = await jiti.import<typeof import("../src/shell.js")>(shellPath);
      expect(child.isInsideSubagentSpawn()).toBe(true);
    });
    const parent = await jiti.import<typeof import("../src/shell.js")>(shellPath);
    expect(parent.isInsideSubagentSpawn()).toBe(false);
  });

  it("keeps the child marker across reload only in the child async context", async () => {
    const first = await import("../src/shell.js");

    await first.withSubagentSpawn(async () => {
      vi.resetModules();
      const reloaded = await import("../src/shell.js");
      expect(reloaded.isInsideSubagentSpawn()).toBe(true);
    });

    const parent = await import("../src/shell.js");
    expect(parent.isInsideSubagentSpawn()).toBe(false);
  });
});
