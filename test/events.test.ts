import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  manager: null as any,
  navigator: null as any,
  coordinator: null as any,
  navigatorArgs: [] as any[][],
  store: {
    concurrency: { default: 4, providers: {}, models: {} },
    agent: { expandListByDefault: false },
    setDeps: vi.fn(),
  },
}));

vi.mock("../src/shell.js", () => ({
  getManager: () => state.manager,
  getNavigator: () => state.navigator,

  getStore: () => state.store,
  getPiInstance: () => ({}),
  getSessionCtx: () => ({ cwd: "/tmp" }),
  setManager: (manager: any) => { state.manager = manager; },
  setNavigator: (navigator: any) => { state.navigator = navigator; },

  setSessionCtx: vi.fn(),
}));

vi.mock("../src/bootstrap/subagent-runtime.js", () => ({
  createHostSubagentRuntime: () => ({
    setOnComplete: vi.fn(),
    setOnRemove: vi.fn(),
  }),
}));

vi.mock("../src/bootstrap/session-host.js", () => ({
  createSessionHost: () => ({
    pendingResultCount: vi.fn(),
    interact: vi.fn(),
  }),
  bindSessionHost: vi.fn(),
  currentSessionHost: () => state.coordinator,
}));

vi.mock("../src/ui/agent-navigator.js", () => ({
  AgentNavigator: class {
    constructor(...args: any[]) {
      state.navigatorArgs.push(args);
    }
  },
}));

import { ensureManagerAndNavigator } from "../src/events.js";

describe("ensureManagerAndNavigator", () => {
  beforeEach(() => {
    state.manager = null;
    state.navigator = null;
    state.coordinator = null;
    state.navigatorArgs = [];
    state.store.agent.expandListByDefault = false;
    state.store.setDeps.mockClear();
  });

  it("passes the persisted list expansion default to a new navigator", () => {
    ensureManagerAndNavigator();

    expect(state.navigatorArgs).toHaveLength(1);
    expect(state.navigatorArgs[0][3]).toBe(false);
  });
});
