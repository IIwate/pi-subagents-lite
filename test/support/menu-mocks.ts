import { afterEach, beforeEach, vi } from "vitest";
import { ConfigStore } from "../../src/config/config-store.js";
import { createDefaultConfig, createMemoryConfigIO, createTestHarness, type MemoryConfigIO, type TestHarness } from "./harness.js";
import type { SubagentsConfig } from "../../src/config/types.js";
import type { AgentManager } from "../../src/agents/agent-manager.js";

let harness: TestHarness;
let currentMemIO: MemoryConfigIO;
let currentStore: ConfigStore;

beforeEach(() => {
  harness = createTestHarness();
  currentMemIO = harness.memIO;
  currentStore = harness.store;
});

afterEach(async () => { await harness.dispose(); });

export function resetMenuStore(initial: Partial<SubagentsConfig> = {}): { store: ConfigStore; memIO: MemoryConfigIO } {
  currentStore.dispose();
  currentMemIO = createMemoryConfigIO(createDefaultConfig(initial));
  currentStore = new ConfigStore(currentMemIO.io);
  const store = currentStore;
  harness.onDispose(() => store.dispose());
  return { store, memIO: currentMemIO };
}

export function getMenuStore(): ConfigStore {
  return currentStore;
}

export const mockModules = {
  mockNavigator: { setDebugStatusPreview: vi.fn() },
  mockManager: {
    armDebugFault: vi.fn(),
    clearDebugFault: vi.fn(),
    debugDiagnostics: vi.fn<AgentManager["debugDiagnostics"]>(() => ({ agents: [] })),
    listAgents: vi.fn(() => []),
  },
};

vi.mock("../../src/agents/agent-types.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/agents/agent-types.js")>(),
  getConfig: vi.fn(() => ({ displayName: "unknown" })),
  getAgentConfig: vi.fn(),
  getAvailableTypes: vi.fn(() => ["general-purpose", "Explore"]),
  getAllTypes: vi.fn(() => ["general-purpose", "Explore"]),
  resolveType: vi.fn((name: string) => name),
  discoverNewAgents: vi.fn(async () => 0),
  setDefaultAgentsDisabled: vi.fn(),
}));

export let selectDialogInstances: Array<{ items: any[]; callbacks: any }> = [];
export function resetSelectDialogInstances() { selectDialogInstances = []; }

vi.mock("../../src/ui/searchable-select.js", () => ({
  SearchableSelectDialog: class MockSearchableSelectDialog {
    items: any[];
    callbacks: any;
    constructor(items: any[], _currentValue: any, callbacks: any) {
      this.items = items;
      this.callbacks = callbacks;
      selectDialogInstances.push(this as any);
    }
    handleInput() {}
    invalidate() {}
  },
}));

vi.mock("../../src/ui/format.js", () => ({ getDisplayName: vi.fn((type: string) => type) }));

vi.mock("../../src/config/config-io.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/config-io.js")>();
  return {
    ...actual,
    saveConfigAtomic: vi.fn(),
  };
});

vi.mock("../../src/agents/tool-execution.js", () => ({
  formatResultContent: vi.fn((record: any) => record.result ?? ""),
}));

vi.mock("../../src/shell.js", () => ({
  getStore: () => currentStore,
  getNavigator: () => mockModules.mockNavigator,
  getManager: () => mockModules.mockManager,
}));
