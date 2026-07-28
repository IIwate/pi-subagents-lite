/**
 * menu-mock-setup.ts — Shared mock setup for menu tests.
 *
 * This file MUST be imported as the FIRST import in each menu test file.
 * It sets up vi.mock() calls for all menu dependencies.
 *
 * The mockModules object is returned so test files can access mock state.
 */

import { vi } from "vitest";
import { CONFIG_AGENT_NON_MODEL_KEYS } from "../src/config/types.js";

// Create the mock modules object
export const mockModules = {
  mockConfig: {
    agent: { default: null, forceBackground: false } as Record<string, any>,
    concurrency: { default: 4 } as Record<string, any>,
  },
  mockSessionOverrides: { default: null } as Record<string, any>,
  mockPiInstance: null as any,
  mockNavigator: { setDebugStatusPreview: vi.fn() },
  mockManager: {
    armDebugFault: vi.fn(),
    clearDebugFault: vi.fn(),
    debugDiagnostics: vi.fn(() => ({ agents: [] })),
  },
};

// Set up the Pi instance mock
mockModules.mockPiInstance = { sendUserMessage: vi.fn() };

// --- vi.mock() calls ---

vi.mock("../src/agents/agent-types.js", () => ({
  getConfig: vi.fn(() => ({ displayName: "unknown" })),
  getAgentConfig: vi.fn(),
  getAvailableTypes: vi.fn(() => ["general-purpose", "Explore"]),
  getAllTypes: vi.fn(() => ["general-purpose", "Explore"]),
  resolveType: vi.fn((name: string) => name),
  discoverNewAgents: vi.fn(async () => 0),
}));

// Capture SearchableSelectDialog instances for tests that need them
export let selectDialogInstances: Array<{ items: any[]; callbacks: any }> = [];
export function resetSelectDialogInstances() { selectDialogInstances = []; }

vi.mock("../src/ui/searchable-select.js", () => ({
  SearchableSelectDialog: class MockSearchableSelectDialog {
    items: any[];
    callbacks: any;
    constructor(items: any[], _currentValue: any, callbacks: any, _theme: any) {
      this.items = items;
      this.callbacks = callbacks;
      selectDialogInstances.push(this as any);
    }
    handleInput(_data: string) {}
    invalidate() {}
  },
}));

vi.mock("../src/ui/format.js", () => ({
  getDisplayName: vi.fn((t: string) => t),
}));

vi.mock("../src/config/config-io.js", () => ({
  saveConfigAtomic: vi.fn(),
  DEFAULT_GRACE_TURNS: 6,
  CUSTOM_PROMPT_PATH: "/home/test/.pi/agent/subagents-lite-prompt.md",
  DEFAULT_CONFIG: {
    agent: { default: null, forceBackground: false },
    concurrency: { default: 4 },
  },
}));

vi.mock("../src/agents/tool-execution.js", () => ({
  formatResultContent: vi.fn((record: any) => record.result ?? ""),
}));

vi.mock("../src/shell.js", () => {
  const mockStore = {
    get agent() {
      const a = mockModules.mockConfig.agent;
      return {
        defaultModel: a.default ?? null,
        forceBackground: a.forceBackground === true,
        showCost: a.showCost === true,
        graceTurns: a.graceTurns ?? 6,
        systemPromptMode: a.systemPromptMode ?? "replace",
        includeContextFiles: a.includeContextFiles ?? true,
        defaultThinking: a.defaultThinking,
        loadSkillsImplicitly: a.loadSkillsImplicitly !== false,
        loadExtensionsImplicitly: a.loadExtensionsImplicitly !== false,
        showTools: a.showTools !== false,
        showTurns: a.showTurns !== false,
        showInput: a.showInput !== false,
        showOutput: a.showOutput !== false,
        showContext: a.showContext !== false,
        showTime: a.showTime !== false,
      };
    },
    get concurrency() {
      return {
        default: mockModules.mockConfig.concurrency.default,
        providers: mockModules.mockConfig.concurrency.providers ?? {},
        models: mockModules.mockConfig.concurrency.models ?? {},
      };
    },
    get sessionDefaultModel() {
      return mockModules.mockSessionOverrides.default ?? null;
    },
    sessionModelOverride(type: string) {
      return mockModules.mockSessionOverrides[type] ?? null;
    },
    agentConfigSnapshot() {
      return mockModules.mockConfig.agent;
    },
    modelFor(type: string, parentModelId: string, agentConfig?: any) {
      const sessionOverride = mockModules.mockSessionOverrides[type];
      if (sessionOverride) return sessionOverride;
      const sessionDefault = mockModules.mockSessionOverrides.default;
      if (sessionDefault) return sessionDefault;
      const configOverride = mockModules.mockConfig.agent[type];
      if (configOverride) return configOverride;
      const configDefault = mockModules.mockConfig.agent.default;
      if (configDefault) return configDefault;
      if (agentConfig?.model) return agentConfig.model;
      return parentModelId;
    },
    mutate: {
      agent: {
        setModelOverride(type: string, value: string | null) { mockModules.mockConfig.agent[type] = value; },
        clearModelOverride(type: string) { delete mockModules.mockConfig.agent[type]; },
        clearAllModelOverrides() {
          const preserved: Record<string, unknown> = {};
          // Share the production non-model key list with clearAllModelOverrides to prevent drift.
          for (const key of CONFIG_AGENT_NON_MODEL_KEYS) {
            const val = mockModules.mockConfig.agent[key];
            if (val != null || key === 'default' || key === 'forceBackground') {
              preserved[key] = val;
            }
          }
          mockModules.mockConfig.agent = preserved as any;
        },
        setForceBackground(enabled: boolean) { mockModules.mockConfig.agent.forceBackground = enabled; },
        setShowCost(enabled: boolean) { mockModules.mockConfig.agent.showCost = enabled; },
        setGraceTurns(n: number) { mockModules.mockConfig.agent.graceTurns = n; },
        setSystemPromptMode(mode: string) { mockModules.mockConfig.agent.systemPromptMode = mode; },
        setIncludeContextFiles(enabled: boolean) { mockModules.mockConfig.agent.includeContextFiles = enabled; },
        setDefaultThinking(level: string | undefined) { mockModules.mockConfig.agent.defaultThinking = level; },
        setLoadSkillsImplicitly(value: boolean) { mockModules.mockConfig.agent.loadSkillsImplicitly = value; },
        setLoadExtensionsImplicitly(value: boolean) { mockModules.mockConfig.agent.loadExtensionsImplicitly = value; },
        setShowTools(enabled: boolean) { mockModules.mockConfig.agent.showTools = enabled; },
        setShowTurns(enabled: boolean) { mockModules.mockConfig.agent.showTurns = enabled; },
        setShowInput(enabled: boolean) { mockModules.mockConfig.agent.showInput = enabled; },
        setShowOutput(enabled: boolean) { mockModules.mockConfig.agent.showOutput = enabled; },
        setShowContext(enabled: boolean) { mockModules.mockConfig.agent.showContext = enabled; },
        setShowTime(enabled: boolean) { mockModules.mockConfig.agent.showTime = enabled; }
      },
      concurrency: {
        setDefault(n: number) { mockModules.mockConfig.concurrency.default = n; },
        setProvider(key: string, n: number) {
          if (!mockModules.mockConfig.concurrency.providers) mockModules.mockConfig.concurrency.providers = {};
          mockModules.mockConfig.concurrency.providers[key] = n;
        },
        setModel(key: string, n: number) {
          if (!mockModules.mockConfig.concurrency.models) mockModules.mockConfig.concurrency.models = {};
          mockModules.mockConfig.concurrency.models[key] = n;
        },
        removeProvider(key: string) {
          if (mockModules.mockConfig.concurrency.providers) delete mockModules.mockConfig.concurrency.providers[key];
        },
        removeModel(key: string) {
          if (mockModules.mockConfig.concurrency.models) delete mockModules.mockConfig.concurrency.models[key];
        },
        reset() {
          mockModules.mockConfig.concurrency = { default: 4 };
        },
      },
      session: {
        setOverride(type: string, model: string) { mockModules.mockSessionOverrides[type] = model; },
        clearOverride(type: string) { delete mockModules.mockSessionOverrides[type]; },
        clearAll() { mockModules.mockSessionOverrides = { default: null }; },
      },
    },
  };

  return {
    getStore: () => mockStore,
    getPiInstance: () => mockModules.mockPiInstance,
    getNavigator: () => mockModules.mockNavigator,
    getManager: () => mockModules.mockManager,
  };
});
