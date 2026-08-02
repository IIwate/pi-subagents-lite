/**
 * menu-mock-setup.ts — Shared mock setup for menu tests.
 *
 * This file MUST be imported as the FIRST import in each menu test file.
 * It sets up vi.mock() calls for all menu dependencies.
 *
 * The mockModules object is returned so test files can access mock state.
 */

import { vi } from "vitest";

// Create the mock modules object
export const mockModules = {
  mockConfig: {
    modelRouting: {
      enabled: false,
      allowedProviders: [] as string[],
      agentModels: {} as Record<string, string>,
    },
    agent: { forceBackground: false } as Record<string, any>,
    concurrency: { default: 4 } as Record<string, any>,
  },
  mockSessionOverrides: {} as Record<string, string>,
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
    modelRouting: { enabled: false, allowedProviders: [], agentModels: {} },
    agent: { forceBackground: false },
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
        forceBackground: a.forceBackground === true,
        showCost: a.showCost === true,
        graceTurns: a.graceTurns ?? 6,
        systemPromptMode: a.systemPromptMode ?? "replace",
        includeContextFiles: a.includeContextFiles ?? true,
        defaultThinking: a.defaultThinking,
        loadSkillsImplicitly: a.loadSkillsImplicitly !== false,
        loadExtensionsImplicitly: a.loadExtensionsImplicitly !== false,
        disableDefaultAgents: a.disableDefaultAgents === true,
        showTools: a.showTools !== false,
        showTurns: a.showTurns !== false,
        showInput: a.showInput !== false,
        showOutput: a.showOutput !== false,
        showContext: a.showContext !== false,
        showTime: a.showTime !== false,
      };
    },
    get routing() {
      const r = mockModules.mockConfig.modelRouting;
      return {
        enabled: r.enabled === true,
        allowedProviders: [...(r.allowedProviders ?? [])],
        agentModels: { ...(r.agentModels ?? {}) },
      };
    },
    get concurrency() {
      return {
        default: mockModules.mockConfig.concurrency.default,
        providers: mockModules.mockConfig.concurrency.providers ?? {},
        models: mockModules.mockConfig.concurrency.models ?? {},
      };
    },
    sessionModelOverride(type: string) {
      return mockModules.mockSessionOverrides[type] ?? null;
    },
    modelSelectionFor(type: string, parentModelId: string, agentConfig?: any) {
      const sessionOverride = mockModules.mockSessionOverrides[type];
      if (sessionOverride) return { model: sessionOverride, source: "automatic" };
      const persistent = mockModules.mockConfig.modelRouting.agentModels[type];
      if (persistent) return { model: persistent, source: "automatic" };
      if (agentConfig?.model) return { model: agentConfig.model, source: "automatic" };
      return { model: parentModelId, source: "parent" };
    },
    mutate: {
      routing: {
        setEnabled(enabled: boolean) { mockModules.mockConfig.modelRouting.enabled = enabled; },
        setProviderAllowed(provider: string, allowed: boolean) {
          const set = new Set(mockModules.mockConfig.modelRouting.allowedProviders ?? []);
          if (allowed) set.add(provider); else set.delete(provider);
          mockModules.mockConfig.modelRouting.allowedProviders = [...set];
        },
        removeProvider(provider: string) {
          mockModules.mockConfig.modelRouting.allowedProviders =
            (mockModules.mockConfig.modelRouting.allowedProviders ?? []).filter((p: string) => p !== provider);
          const kept: Record<string, string> = {};
          for (const [type, model] of Object.entries(mockModules.mockConfig.modelRouting.agentModels ?? {})) {
            const slashIdx = model.indexOf("/");
            if (slashIdx <= 0 || model.slice(0, slashIdx) !== provider) kept[type] = model;
          }
          mockModules.mockConfig.modelRouting.agentModels = kept;
        },
        setAgentModel(type: string, model: string | null) {
          if (model === null || model === "") {
            delete mockModules.mockConfig.modelRouting.agentModels[type];
          } else {
            mockModules.mockConfig.modelRouting.agentModels[type] = model;
          }
        },
        clearAll() {
          mockModules.mockConfig.modelRouting = { enabled: false, allowedProviders: [], agentModels: {} };
        },
      },
      agent: {
        setForceBackground(enabled: boolean) { mockModules.mockConfig.agent.forceBackground = enabled; },
        setShowCost(enabled: boolean) { mockModules.mockConfig.agent.showCost = enabled; },
        setGraceTurns(n: number) { mockModules.mockConfig.agent.graceTurns = n; },
        setSystemPromptMode(mode: string) { mockModules.mockConfig.agent.systemPromptMode = mode; },
        setIncludeContextFiles(enabled: boolean) { mockModules.mockConfig.agent.includeContextFiles = enabled; },
        setDefaultThinking(level: string | undefined) { mockModules.mockConfig.agent.defaultThinking = level; },
        setLoadSkillsImplicitly(value: boolean) { mockModules.mockConfig.agent.loadSkillsImplicitly = value; },
        setLoadExtensionsImplicitly(value: boolean) { mockModules.mockConfig.agent.loadExtensionsImplicitly = value; },
        setDisableDefaultAgents(value: boolean) { mockModules.mockConfig.agent.disableDefaultAgents = value; },
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
        clearAll() { mockModules.mockSessionOverrides = {}; },
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
