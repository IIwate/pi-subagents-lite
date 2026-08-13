import { beforeEach, describe, expect, it, vi } from "vitest";

// The navigator seed value flows from the persisted document through the real
// bootstrap seams (configuration -> agent-settings), so this suite pins HOME
// to a temp directory with a known document instead of mocking the store.
const state = await vi.hoisted(async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const home = mkdtempSync(path.join(tmpdir(), "events-test-home-"));
  mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    path.join(home, ".pi", "agent", "subagents-lite.json"),
    JSON.stringify({ agent: { expandListByDefault: false, showTurns: false } }),
  );
  process.env.HOME = home;
  return {
    navigatorArgs: [] as any[][],
    statsCalls: [] as any[],
  };
});

vi.mock("../src/bootstrap/subagent-runtime.js", () => ({
  createHostSubagentRuntime: () => ({
    setOnComplete: vi.fn(),
    setOnRemove: vi.fn(),
    replaceLimits: vi.fn(),
  }),
}));

vi.mock("../src/bootstrap/session-host.js", () => ({
  wireHostDelivery: () => ({
    pendingResultCount: vi.fn(),
  }),
  interactAgent: vi.fn(),
  applyDeliveryCommand: vi.fn(),
  isParentRunSuccessful: vi.fn(),
}));

vi.mock("../src/bootstrap/child-screen.js", () => ({
  ChildScreenHost: class {
    constructor(...args: any[]) {
      state.navigatorArgs.push(args);
    }
    setStatsVisibility(visibility: unknown) {
      state.statsCalls.push(visibility);
    }
    update() {}
  },
}));

import { ensureManagerAndNavigator } from "../src/events.js";
import { createExtensionRuntime, type ExtensionRuntime } from "../src/bootstrap/extension-runtime.js";

describe("ensureManagerAndNavigator", () => {
  const ctx = { cwd: "/tmp" } as any;
  let runtime: ExtensionRuntime;

  beforeEach(() => {
    runtime = createExtensionRuntime({} as any);
    state.navigatorArgs = [];
    state.statsCalls = [];
  });

  it("passes the persisted list expansion default to a new navigator", () => {
    ensureManagerAndNavigator(runtime, ctx);

    expect(state.navigatorArgs).toHaveLength(1);
    expect(state.navigatorArgs[0][3]).toBe(false);
  });

  it("seeds the new navigator's stats visibility from the persisted display settings", () => {
    ensureManagerAndNavigator(runtime, ctx);

    expect(state.statsCalls).toHaveLength(1);
    expect(state.statsCalls[0]).toMatchObject({ showTurns: false, showTools: true });
  });
});
