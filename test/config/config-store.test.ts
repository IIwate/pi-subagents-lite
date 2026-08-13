import { describe, expect, it } from "vitest";
import { ConfigStore, createConfigurationSectionIO } from "../../src/config/config-store.ts";
import {
  createConfiguration,
  type ConfigurationDocumentRepository,
  type JsonObject,
} from "../../src/modules/configuration/public.js";
import type { ModelRoutingConfig } from "../../src/config/types.ts";

function harness(initial: JsonObject = {}) {
  let current = structuredClone(initial);
  const saves: JsonObject[] = [];
  const repository: ConfigurationDocumentRepository = {
    load: () => structuredClone(current),
    persist: (document) => {
      current = structuredClone(document);
      saves.push(structuredClone(document));
    },
  };
  const configuration = createConfiguration({ repository });
  const store = new ConfigStore(createConfigurationSectionIO(configuration));
  return { store, saves, document: () => current };
}

describe("ConfigStore resolved reads", () => {
  it("returns canonical defaults for an empty document", () => {
    const { store } = harness();
    expect(store.routing).toEqual({ enabled: false, enabledProviders: [], agentAccess: {} });
    expect(store.agent.graceTurns).toBe(6);
    expect(store.agent.expandListByDefault).toBe(true);
    expect(store.agent).not.toHaveProperty("defaultThinking");
    expect(store.concurrency).toEqual({ default: 4, providers: {}, models: {} });
  });

  it("ignores retired and assignment-era agent keys at load without scrubbing them from disk", () => {
    const { store, saves } = harness({
      agent: {
        backgroundDelivery: "next-turn",
        defaultThinking: "xhigh",
        default: "openai/gpt-5",
        Explore: "openai/gpt-5",
        graceTurns: 9,
      },
    });
    // ADR-0008 requires retired keys to be silently ignored when resolving
    // runtime settings. The fragment commit must not delete unrecognized keys:
    // this build cannot distinguish retired junk from keys a newer capability
    // owns, so scrubbing would destroy data it does not understand.
    expect(store.agent).not.toHaveProperty("defaultThinking");
    expect(store.agent).not.toHaveProperty("backgroundDelivery");
    expect(store.agent.graceTurns).toBe(9);
    store.mutate.agent.setGraceTurns(4);
    const persistedAgent = saves[0]!.agent as Record<string, unknown>;
    expect(persistedAgent.graceTurns).toBe(4);
    expect(persistedAgent.defaultThinking).toBe("xhigh");
    expect(persistedAgent.Explore).toBe("openai/gpt-5");
  });

  it("returns deep copies of nested access rules", () => {
    const modelRouting: ModelRoutingConfig = {
      enabled: true,
      enabledProviders: ["openai"],
      agentAccess: {
        Explore: {
          parentModelAccess: false,
          providers: { openai: { models: ["gpt-5"] } },
          thinking: {
            "openai/gpt-5": { allowed: ["low", "high"], default: "low" },
          },
        },
      },
    };
    const { store } = harness({ modelRouting: structuredClone(modelRouting) as unknown as JsonObject[string] });
    const copy = store.routing;
    copy.enabledProviders.push("google");
    copy.agentAccess.Explore.providers.openai.models!.push("o3");
    copy.agentAccess.Explore.thinking!["openai/gpt-5"].allowed.push("medium");
    copy.agentAccess.reviewer = { providers: {} };
    expect(store.routing).toEqual(modelRouting);
  });
});

describe("ConfigStore routing mutations", () => {
  it("toggles routing and provider enablement", () => {
    const { store, saves } = harness();
    store.mutate.routing.setEnabled(true);
    store.mutate.routing.setProviderEnabled("openai", true);
    store.mutate.routing.setProviderEnabled("google", true);
    store.mutate.routing.setProviderEnabled("openai", false);
    expect(store.routing.enabled).toBe(true);
    expect(store.routing.enabledProviders).toEqual(["google"]);
    expect(saves).toHaveLength(4);
  });

  it("pauses a provider without deleting dormant Agent rules", () => {
    const modelRouting = {
      enabled: true,
      enabledProviders: ["openai"],
      agentAccess: { Explore: { providers: { openai: { models: ["gpt-5"] } } } },
    };
    const { store } = harness({ modelRouting });
    store.mutate.routing.setProviderEnabled("openai", false);
    expect(store.routing.enabledProviders).toEqual([]);
    expect(store.routing.agentAccess).toEqual(modelRouting.agentAccess);
    store.mutate.routing.setProviderEnabled("openai", true);
    expect(store.routing.agentAccess).toEqual(modelRouting.agentAccess);
  });

  it("stores all-model and exact-model rules canonically", () => {
    const { store } = harness();
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
    const { store } = harness();
    store.mutate.routing.setAgentProviderAccess("Explore", "openai", ["gpt-5"]);
    store.mutate.routing.setAgentProviderAccess("Explore", "openai", []);
    expect(store.routing.agentAccess).toEqual({});
  });

  it("stores and removes prototype-like IDs without touching object prototypes", () => {
    const { store } = harness();
    store.mutate.routing.setAgentProviderAccess("constructor", "__proto__", ["worker"]);
    const access = store.routing.agentAccess;
    expect(Object.hasOwn(access, "constructor")).toBe(true);
    expect(Object.hasOwn(access.constructor.providers, "__proto__")).toBe(true);
    expect(access.constructor.providers.__proto__).toEqual({ models: ["worker"] });

    store.mutate.routing.setAgentProviderAccess("constructor", "__proto__", []);
    expect(Object.hasOwn(store.routing.agentAccess, "constructor")).toBe(false);
  });

  it("applies Quick setup atomically through canonical state", () => {
    const { store, saves } = harness();
    store.mutate.routing.configureAgentProviderAccess("Explore", "anthropic", ["haiku", "opus"]);
    expect(saves).toHaveLength(1);
    expect(store.routing).toEqual({
      enabled: true,
      enabledProviders: ["anthropic"],
      agentAccess: { Explore: { providers: { anthropic: { models: ["haiku", "opus"] } } } },
    });
  });

  it("leaves no partial Quick setup state when the selection is invalid", () => {
    const { store, saves } = harness();
    store.mutate.routing.configureAgentProviderAccess("Explore", "anthropic", []);
    expect(saves).toHaveLength(0);
    expect(store.routing).toEqual({ enabled: false, enabledProviders: [], agentAccess: {} });
  });

  it("stores Parent model denial without requiring a Provider rule", () => {
    const { store } = harness();
    store.mutate.routing.setParentModelAccess("Explore", false);
    expect(store.routing.agentAccess).toEqual({
      Explore: { parentModelAccess: false, providers: {} },
    });

    store.mutate.routing.setParentModelAccess("Explore", true);
    expect(store.routing.agentAccess).toEqual({});
  });

  it("stores and explicitly resets exact-model thinking overrides", () => {
    const { store } = harness();
    store.mutate.routing.setThinkingAccess(
      "Explore",
      "openai/gpt-5",
      ["high", "low", "high"],
      "low",
    );
    expect(store.routing.agentAccess).toEqual({
      Explore: {
        providers: {},
        thinking: {
          "openai/gpt-5": { allowed: ["high", "low"], default: "low" },
        },
      },
    });

    store.mutate.routing.resetThinkingAccess("Explore", "openai/gpt-5");
    expect(store.routing.agentAccess).toEqual({});
  });

  it("deletes one provider from every registered or unavailable Agent rule", () => {
    const { store } = harness({
      modelRouting: {
        enabled: true,
        enabledProviders: ["openai", "google"],
        agentAccess: {
          Explore: { providers: { openai: { models: ["gpt-5"] }, google: {} } },
          "ghost-agent": { providers: { openai: {} } },
        },
      },
    });
    store.mutate.routing.deleteProviderRules("openai");
    expect(store.routing.enabledProviders).toEqual(["openai", "google"]);
    expect(store.routing.agentAccess).toEqual({ Explore: { providers: { google: {} } } });
  });

  it("cleans exact unavailable IDs without touching all-model rules", () => {
    const { store } = harness({
      modelRouting: {
        enabled: true,
        enabledProviders: ["openai"],
        agentAccess: {
          Explore: { providers: { openai: { models: ["gpt-5", "retired"] } } },
          reviewer: { providers: { openai: { models: ["retired"] } } },
          planner: { providers: { openai: {} } },
        },
      },
    });
    store.mutate.routing.cleanUnavailableModels("openai", ["retired"]);
    expect(store.routing.agentAccess).toEqual({
      Explore: { providers: { openai: { models: ["gpt-5"] } } },
      planner: { providers: { openai: {} } },
    });
  });

  it("lists unavailable Agent types with saved provider rules", () => {
    const { store } = harness({
      modelRouting: {
        enabled: false,
        enabledProviders: [],
        agentAccess: {
          Explore: { providers: { openai: {} } },
          "ghost-agent": { providers: { openai: { models: ["gpt"] }, google: {} } },
        },
      },
    });
    expect(store.accessTypesForProvider("openai")).toEqual(["Explore", "ghost-agent"]);
    expect(store.accessTypesForProvider("google")).toEqual(["ghost-agent"]);
  });

  it("clears the complete Model access policy", () => {
    const { store } = harness({
      modelRouting: {
        enabled: true,
        enabledProviders: ["openai"],
        agentAccess: {
          Explore: {
            parentModelAccess: false,
            providers: { openai: {} },
            thinking: {
              "openai/gpt-5": { allowed: ["low"], default: "low" },
            },
          },
        },
      },
    });
    store.mutate.routing.clearAll();
    expect(store.routing).toEqual({ enabled: false, enabledProviders: [], agentAccess: {} });
  });
});

describe("ConfigStore persistence boundary", () => {
  it("persists Agent and concurrency settings as their own sections", () => {
    const { store, saves, document } = harness();
    store.mutate.agent.setGraceTurns(9);
    store.mutate.agent.setShowCost(true);
    store.mutate.agent.setExpandListByDefault(false);
    store.mutate.concurrency.setDefault(2);
    store.mutate.concurrency.setProvider("openai", 1);
    store.mutate.concurrency.setModel("openai/gpt-5", 3);
    expect(store.agent.graceTurns).toBe(9);
    expect(store.agent.showCost).toBe(true);
    expect(store.agent.expandListByDefault).toBe(false);
    expect(store.concurrency).toEqual({
      default: 2,
      providers: { openai: 1 },
      models: { "openai/gpt-5": 3 },
    });
    expect(saves).toHaveLength(6);
    expect(document().concurrency).toEqual({
      default: 2,
      providers: { openai: 1 },
      models: { "openai/gpt-5": 3 },
    });
  });

  it("commits one section without rewriting the other sections' persisted content", () => {
    const { store, document } = harness({
      modelRouting: { enabled: "yes-please" as unknown as boolean, enabledProviders: [], agentAccess: {} },
      concurrency: { default: 7 },
    });
    store.mutate.agent.setGraceTurns(2);
    // The malformed routing block stays byte-identical on disk; only reads
    // normalize it. Rewriting unowned sections would destroy user data that a
    // newer version might still understand.
    expect(document().modelRouting).toEqual({ enabled: "yes-please", enabledProviders: [], agentAccess: {} });
    expect(document().concurrency).toEqual({ default: 7 });
  });

  it("never writes a revision field into the persisted document", () => {
    const { store, saves } = harness();
    store.mutate.concurrency.setDefault(3);
    expect(saves[0]).not.toHaveProperty("revision");
    expect(Object.keys(saves[0]!.concurrency as object)).toEqual(["default"]);
  });

  it("reloads persisted state", () => {
    const { store, document } = harness();
    store.mutate.agent.setGraceTurns(3);
    store.mutate.routing.setEnabled(true);
    const persisted = document();
    const next = harness(persisted);
    next.store.reload();
    expect(next.store.agent.graceTurns).toBe(3);
    expect(next.store.routing.enabled).toBe(true);
  });

  it("syncs injected manager and navigator dependencies", () => {
    const { store } = harness();
    const visibility: unknown[] = [];
    const concurrencies: unknown[] = [];
    store.setDeps({
      navigator: { setStatsVisibility: (value: unknown) => visibility.push(value) } as any,
      manager: { replaceLimits: (value: unknown) => concurrencies.push(value) } as any,
    });
    store.mutate.agent.setShowTools(false);
    store.mutate.concurrency.setDefault(8);
    expect(visibility.length).toBeGreaterThan(1);
    expect(concurrencies.length).toBeGreaterThan(1);
  });
});
