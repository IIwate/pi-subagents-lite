import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  manager: null as any,
  navigator: null as any,
  delivery: null as any,
  navigatorArgs: [] as any[][],
  store: {
    concurrency: { default: 4, providers: {}, models: {} },
    agent: { expandListByDefault: false },
    setDeps: vi.fn(),
  },
}));

vi.mock("../src/shell.js", () => ({
  getManager: () => state.manager,
  getDelivery: () => state.delivery,
  getNavigator: () => state.navigator,

  getStore: () => state.store,
  getPiInstance: () => ({}),
  getSessionCtx: () => ({ cwd: "/tmp" }),
  setManager: (manager: any) => { state.manager = manager; },
  setDelivery: (delivery: any) => { state.delivery = delivery; },
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
  },
}));

import { ensureManagerAndNavigator } from "../src/events.js";

describe("ensureManagerAndNavigator", () => {
  beforeEach(() => {
    state.manager = null;
    state.navigator = null;
    state.delivery = null;
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
