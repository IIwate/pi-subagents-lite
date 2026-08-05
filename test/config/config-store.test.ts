import { describe, expect, it } from "vitest";
import { ConfigStore, type ConfigIO } from "../../src/config/config-store.ts";
import type { SubagentsConfig } from "../../src/config/types.ts";

function defaultConfig(): SubagentsConfig {
  return {
    modelRouting: { enabled: false, enabledProviders: [], agentAccess: {} },
    agent: {
      forceBackground: false,
      backgroundDelivery: "auto",
      graceTurns: 6,
      systemPromptMode: "replace",
      includeContextFiles: true,
      disableDefaultAgents: false,
      showTools: true,
      showTurns: true,
      showInput: true,
      showOutput: true,
      showContext: true,
      showCost: false,
      showTime: true,
    },
    concurrency: { default: 4 },
  };
}

function memIO(initial: SubagentsConfig = defaultConfig()) {
  let current = structuredClone(initial);
  const saves: SubagentsConfig[] = [];
  const io: ConfigIO = {
    load: () => structuredClone(current),
    save: (config) => {
      current = structuredClone(config);
      saves.push(structuredClone(config));
    },
  };
  return { io, saves, current: () => current };
}

describe("ConfigStore routing reads", () => {
  it("returns canonical defaults", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.routing).toEqual({ enabled: false, enabledProviders: [], agentAccess: {} });
    expect(store.agent.graceTurns).toBe(6);
    expect(store.agent.backgroundDelivery).toBe("auto");
    expect(store.concurrency).toEqual({ default: 4, providers: {}, models: {} });
  });

  it("returns deep copies of nested access rules", () => {
    const config = defaultConfig();
    config.modelRouting = {
      enabled: true,
      enabledProviders: ["openai"],
      agentAccess: { Explore: { providers: { openai: { models: ["gpt-5"] } } } },
    };
    const store = new ConfigStore(memIO(config).io);
    const copy = store.routing;
    copy.enabledProviders.push("google");
    copy.agentAccess.Explore.providers.openai.models!.push("o3");
    copy.agentAccess.reviewer = { providers: {} };
    expect(store.routing).toEqual(config.modelRouting);
  });
});

describe("ConfigStore routing mutations", () => {
  it("toggles routing and provider enablement", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);
    store.mutate.routing.setEnabled(true);
    store.mutate.routing.setProviderEnabled("openai", true);
    store.mutate.routing.setProviderEnabled("google", true);
    store.mutate.routing.setProviderEnabled("openai", false);
    expect(store.routing.enabled).toBe(true);
    expect(store.routing.enabledProviders).toEqual(["google"]);
    expect(saves).toHaveLength(4);
  });

  it("pauses a provider without deleting dormant Agent rules", () => {
    const config = defaultConfig();
    config.modelRouting = {
      enabled: true,
      enabledProviders: ["openai"],
      agentAccess: { Explore: { providers: { openai: { models: ["gpt-5"] } } } },
    };
    const store = new ConfigStore(memIO(config).io);
    store.mutate.routing.setProviderEnabled("openai", false);
    expect(store.routing.enabledProviders).toEqual([]);
    expect(store.routing.agentAccess).toEqual(config.modelRouting.agentAccess);
    store.mutate.routing.setProviderEnabled("openai", true);
    expect(store.routing.agentAccess).toEqual(config.modelRouting.agentAccess);
  });

  it("stores all-model and exact-model rules canonically", () => {
    const store = new ConfigStore(memIO().io);
    store.mutate.routing.setAgentProviderAccess("Explore", "openai");
    store.mutate.routing.setAgentProviderAccess("Explore", "google", [" gemini-pro ", "", "gemini-pro", "gemini-flash"]);
    expect(store.routing.agentAccess).toEqual({
      Explore: {
        providers: {
          openai: {},
          google: { models: ["gemini-pro", "gemini-flash"] },
        },
      },
    });
  });

  it("deletes empty exact rules and prunes empty Agent entries", () => {
    const store = new ConfigStore(memIO().io);
    store.mutate.routing.setAgentProviderAccess("Explore", "openai", ["gpt-5"]);
    store.mutate.routing.setAgentProviderAccess("Explore", "openai", []);
    expect(store.routing.agentAccess).toEqual({});
  });

  it("stores and removes prototype-like IDs without touching object prototypes", () => {
    const store = new ConfigStore(memIO().io);
    store.mutate.routing.setAgentProviderAccess("constructor", "__proto__", ["worker"]);
    const access = store.routing.agentAccess;
    expect(Object.hasOwn(access, "constructor")).toBe(true);
    expect(Object.hasOwn(access.constructor.providers, "__proto__")).toBe(true);
    expect(access.constructor.providers.__proto__).toEqual({ models: ["worker"] });

    store.mutate.routing.setAgentProviderAccess("constructor", "__proto__", []);
    expect(Object.hasOwn(store.routing.agentAccess, "constructor")).toBe(false);
  });

  it("applies Quick setup atomically through canonical state", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);
    store.mutate.routing.configureAgentProviderAccess("Explore", "anthropic", ["haiku", "opus"]);
    expect(saves).toHaveLength(1);
    expect(store.routing).toEqual({
      enabled: true,
      enabledProviders: ["anthropic"],
      agentAccess: { Explore: { providers: { anthropic: { models: ["haiku", "opus"] } } } },
    });
  });

  it("deletes one provider from every registered or unavailable Agent rule", () => {
    const config = defaultConfig();
    config.modelRouting = {
      enabled: true,
      enabledProviders: ["openai", "google"],
      agentAccess: {
        Explore: { providers: { openai: { models: ["gpt-5"] }, google: {} } },
        "ghost-agent": { providers: { openai: {} } },
      },
    };
    const store = new ConfigStore(memIO(config).io);
    store.mutate.routing.deleteProviderRules("openai");
    expect(store.routing.enabledProviders).toEqual(["openai", "google"]);
    expect(store.routing.agentAccess).toEqual({ Explore: { providers: { google: {} } } });
  });

  it("cleans exact unavailable IDs without touching all-model rules", () => {
    const config = defaultConfig();
    config.modelRouting = {
      enabled: true,
      enabledProviders: ["openai"],
      agentAccess: {
        Explore: { providers: { openai: { models: ["gpt-5", "retired"] } } },
        reviewer: { providers: { openai: { models: ["retired"] } } },
        planner: { providers: { openai: {} } },
      },
    };
    const store = new ConfigStore(memIO(config).io);
    store.mutate.routing.cleanUnavailableModels("openai", ["retired"]);
    expect(store.routing.agentAccess).toEqual({
      Explore: { providers: { openai: { models: ["gpt-5"] } } },
      planner: { providers: { openai: {} } },
    });
  });

  it("lists unavailable Agent types with saved provider rules", () => {
    const config = defaultConfig();
    config.modelRouting.agentAccess = {
      Explore: { providers: { openai: {} } },
      "ghost-agent": { providers: { openai: { models: ["gpt"] }, google: {} } },
    };
    const store = new ConfigStore(memIO(config).io);
    expect(store.accessTypesForProvider("openai")).toEqual(["Explore", "ghost-agent"]);
    expect(store.accessTypesForProvider("google")).toEqual(["ghost-agent"]);
  });

  it("clears the complete routing policy", () => {
    const config = defaultConfig();
    config.modelRouting = {
      enabled: true,
      enabledProviders: ["openai"],
      agentAccess: { Explore: { providers: { openai: {} } } },
    };
    const store = new ConfigStore(memIO(config).io);
    store.mutate.routing.clearAll();
    expect(store.routing).toEqual({ enabled: false, enabledProviders: [], agentAccess: {} });
  });
});

describe("ConfigStore non-routing behavior", () => {
  it("persists Agent and concurrency settings", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);
    store.mutate.agent.setGraceTurns(9);
    store.mutate.agent.setBackgroundDelivery("next-turn");
    store.mutate.agent.setShowCost(true);
    store.mutate.concurrency.setDefault(2);
    store.mutate.concurrency.setProvider("openai", 1);
    store.mutate.concurrency.setModel("openai/gpt-5", 3);
    expect(store.agent.graceTurns).toBe(9);
    expect(store.agent.backgroundDelivery).toBe("next-turn");
    expect(store.agent.showCost).toBe(true);
    expect(store.concurrency).toEqual({
      default: 2,
      providers: { openai: 1 },
      models: { "openai/gpt-5": 3 },
    });
    expect(saves).toHaveLength(6);
  });

  it("reloads persisted state", () => {
    const { io, current } = memIO();
    const store = new ConfigStore(io);
    current().agent.graceTurns = 3;
    current().modelRouting.enabled = true;
    store.reload();
    expect(store.agent.graceTurns).toBe(3);
    expect(store.routing.enabled).toBe(true);
  });

  it("syncs injected manager and navigator dependencies", () => {
    const store = new ConfigStore(memIO().io);
    const visibility: unknown[] = [];
    const concurrencies: unknown[] = [];
    store.setDeps({
      navigator: { setStatsVisibility: (value: unknown) => visibility.push(value) } as any,
      manager: { setConcurrency: (value: unknown) => concurrencies.push(value) } as any,
    });
    store.mutate.agent.setShowTools(false);
    store.mutate.concurrency.setDefault(8);
    expect(visibility.length).toBeGreaterThan(1);
    expect(concurrencies.length).toBeGreaterThan(1);
  });
});
