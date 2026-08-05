import { vi } from "vitest";

export const mockModules = {
  mockConfig: {
    modelRouting: {
      enabled: false,
      enabledProviders: [] as string[],
      agentAccess: {} as Record<string, { providers: Record<string, { models?: string[] }> }>,
    },
    agent: { forceBackground: false } as Record<string, any>,
    concurrency: { default: 4 } as Record<string, any>,
  },
  mockNavigator: { setDebugStatusPreview: vi.fn() },
  mockManager: {
    armDebugFault: vi.fn(),
    clearDebugFault: vi.fn(),
    debugDiagnostics: vi.fn(() => ({ agents: [] })),
    listAgents: vi.fn(() => []),
  },
};

vi.mock("../src/agents/agent-types.js", () => ({
  getConfig: vi.fn(() => ({ displayName: "unknown" })),
  getAgentConfig: vi.fn(),
  getAvailableTypes: vi.fn(() => ["general-purpose", "Explore"]),
  getAllTypes: vi.fn(() => ["general-purpose", "Explore"]),
  resolveType: vi.fn((name: string) => name),
  discoverNewAgents: vi.fn(async () => 0),
}));

export let selectDialogInstances: Array<{ items: any[]; callbacks: any }> = [];
export function resetSelectDialogInstances() { selectDialogInstances = []; }

vi.mock("../src/ui/searchable-select.js", () => ({
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

vi.mock("../src/ui/format.js", () => ({ getDisplayName: vi.fn((type: string) => type) }));

vi.mock("../src/config/config-io.js", () => ({
  saveConfigAtomic: vi.fn(),
  DEFAULT_GRACE_TURNS: 6,
  DEFAULT_CONCURRENCY: { default: 4 },
  CUSTOM_PROMPT_PATH: "/home/test/.pi/agent/subagents-lite-prompt.md",
  DEFAULT_CONFIG: {
    modelRouting: { enabled: false, enabledProviders: [], agentAccess: {} },
    agent: { forceBackground: false },
    concurrency: { default: 4 },
  },
}));

vi.mock("../src/agents/tool-execution.js", () => ({
  formatResultContent: vi.fn((record: any) => record.result ?? ""),
}));

vi.mock("../src/shell.js", () => {
  const prune = (type: string) => {
    const access = mockModules.mockConfig.modelRouting.agentAccess[type];
    if (access && Object.keys(access.providers).length === 0) {
      delete mockModules.mockConfig.modelRouting.agentAccess[type];
    }
  };
  const setAccess = (type: string, provider: string, models?: readonly string[]) => {
    const normalized = models === undefined ? undefined : [...new Set(models.filter(Boolean))];
    if (normalized?.length === 0) {
      delete mockModules.mockConfig.modelRouting.agentAccess[type]?.providers[provider];
      prune(type);
      return;
    }
    const agent = mockModules.mockConfig.modelRouting.agentAccess[type] ??= { providers: {} };
    agent.providers[provider] = normalized ? { models: [...normalized] } : {};
  };

  const mockStore = {
    get agent() {
      const agent = mockModules.mockConfig.agent;
      return {
        forceBackground: agent.forceBackground === true,
        backgroundDelivery: agent.backgroundDelivery === "next-turn" ? "next-turn" : "auto",
        showCost: agent.showCost === true,
        graceTurns: agent.graceTurns ?? 6,
        systemPromptMode: agent.systemPromptMode ?? "replace",
        includeContextFiles: agent.includeContextFiles ?? true,
        defaultThinking: agent.defaultThinking,
        loadSkillsImplicitly: agent.loadSkillsImplicitly !== false,
        loadExtensionsImplicitly: agent.loadExtensionsImplicitly !== false,
        disableDefaultAgents: agent.disableDefaultAgents === true,
        showTools: agent.showTools !== false,
        showTurns: agent.showTurns !== false,
        showInput: agent.showInput !== false,
        showOutput: agent.showOutput !== false,
        showContext: agent.showContext !== false,
        showTime: agent.showTime !== false,
      };
    },
    get routing() {
      return structuredClone(mockModules.mockConfig.modelRouting);
    },
    get concurrency() {
      return {
        default: mockModules.mockConfig.concurrency.default,
        providers: mockModules.mockConfig.concurrency.providers ?? {},
        models: mockModules.mockConfig.concurrency.models ?? {},
      };
    },
    accessTypesForProvider(provider: string) {
      return Object.entries(mockModules.mockConfig.modelRouting.agentAccess)
        .filter(([, access]) => Object.hasOwn(access.providers, provider))
        .map(([type]) => type)
        .sort();
    },
    mutate: {
      routing: {
        setEnabled(enabled: boolean) { mockModules.mockConfig.modelRouting.enabled = enabled; },
        setProviderEnabled(provider: string, enabled: boolean) {
          const providers = new Set(mockModules.mockConfig.modelRouting.enabledProviders);
          if (enabled) providers.add(provider); else providers.delete(provider);
          mockModules.mockConfig.modelRouting.enabledProviders = [...providers];
        },
        setAgentProviderAccess(type: string, provider: string, models?: readonly string[]) {
          setAccess(type, provider, models);
        },
        configureAgentProviderAccess(type: string, provider: string, models?: readonly string[]) {
          mockModules.mockConfig.modelRouting.enabled = true;
          this.setProviderEnabled(provider, true);
          setAccess(type, provider, models);
        },
        deleteProviderRules(provider: string) {
          for (const type of Object.keys(mockModules.mockConfig.modelRouting.agentAccess)) {
            delete mockModules.mockConfig.modelRouting.agentAccess[type].providers[provider];
            prune(type);
          }
        },
        cleanUnavailableModels(provider: string, ids: readonly string[]) {
          const stale = new Set(ids);
          for (const type of Object.keys(mockModules.mockConfig.modelRouting.agentAccess)) {
            const rule = mockModules.mockConfig.modelRouting.agentAccess[type].providers[provider];
            if (!rule?.models) continue;
            rule.models = rule.models.filter((id) => !stale.has(id));
            if (rule.models.length === 0) delete mockModules.mockConfig.modelRouting.agentAccess[type].providers[provider];
            prune(type);
          }
        },
        clearAll() {
          mockModules.mockConfig.modelRouting = { enabled: false, enabledProviders: [], agentAccess: {} };
        },
      },
      agent: {
        setForceBackground(value: boolean) { mockModules.mockConfig.agent.forceBackground = value; },
        setBackgroundDelivery(value: "auto" | "next-turn") { mockModules.mockConfig.agent.backgroundDelivery = value; },
        setShowCost(value: boolean) { mockModules.mockConfig.agent.showCost = value; },
        setGraceTurns(value: number) { mockModules.mockConfig.agent.graceTurns = value; },
        setSystemPromptMode(value: string) { mockModules.mockConfig.agent.systemPromptMode = value; },
        setIncludeContextFiles(value: boolean) { mockModules.mockConfig.agent.includeContextFiles = value; },
        setDefaultThinking(value: string | undefined) { mockModules.mockConfig.agent.defaultThinking = value; },
        setLoadSkillsImplicitly(value: boolean) { mockModules.mockConfig.agent.loadSkillsImplicitly = value; },
        setLoadExtensionsImplicitly(value: boolean) { mockModules.mockConfig.agent.loadExtensionsImplicitly = value; },
        setDisableDefaultAgents(value: boolean) { mockModules.mockConfig.agent.disableDefaultAgents = value; },
        setShowTools(value: boolean) { mockModules.mockConfig.agent.showTools = value; },
        setShowTurns(value: boolean) { mockModules.mockConfig.agent.showTurns = value; },
        setShowInput(value: boolean) { mockModules.mockConfig.agent.showInput = value; },
        setShowOutput(value: boolean) { mockModules.mockConfig.agent.showOutput = value; },
        setShowContext(value: boolean) { mockModules.mockConfig.agent.showContext = value; },
        setShowTime(value: boolean) { mockModules.mockConfig.agent.showTime = value; },
      },
      concurrency: {
        setDefault(value: number) { mockModules.mockConfig.concurrency.default = value; },
        setProvider(key: string, value: number) {
          (mockModules.mockConfig.concurrency.providers ??= {})[key] = value;
        },
        setModel(key: string, value: number) {
          (mockModules.mockConfig.concurrency.models ??= {})[key] = value;
        },
        removeProvider(key: string) { delete mockModules.mockConfig.concurrency.providers?.[key]; },
        removeModel(key: string) { delete mockModules.mockConfig.concurrency.models?.[key]; },
        reset() { mockModules.mockConfig.concurrency = { default: 4 }; },
      },
    },
  };

  return {
    getStore: () => mockStore,
    getNavigator: () => mockModules.mockNavigator,
    getManager: () => mockModules.mockManager,
  };
});
