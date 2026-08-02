/**
 * config-store.test.ts — Tests the ConfigStore interface directly.
 *
 * Interface is the test surface: in-memory ConfigIO, stub navigator/manager.
 * No state.ts / config-io / config-mutator mocking — the store owns its state.
 */

import { describe, it, expect } from "vitest";
import { ConfigStore, type ConfigIO } from "../../src/config/config-store.ts";
import type { AgentNavigator } from "../../src/ui/agent-navigator.ts";
import type { AgentManager } from "../../src/agents/agent-manager.ts";
import type { SubagentsConfig } from "../../src/config/types.ts";

function defaultConfig(): SubagentsConfig {
  // Matches the defaults merged by loadConfig when no config file exists
  return {
    modelRouting: {
      enabled: false,
      allowedProviders: [],
      agentModels: {},
    },
    agent: {
      forceBackground: false,
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

/** In-memory ConfigIO. Merges initial config with defaults (matches loadConfig behavior). */
function memIO(initial: Partial<SubagentsConfig> = defaultConfig()): { io: ConfigIO; saves: SubagentsConfig[]; current: () => SubagentsConfig } {
  // Merge with defaults like loadConfig does
  const merged: SubagentsConfig = {
    modelRouting: {
      enabled: initial.modelRouting?.enabled === true,
      allowedProviders: [...(initial.modelRouting?.allowedProviders ?? [])],
      agentModels: { ...(initial.modelRouting?.agentModels ?? {}) },
    },
    agent: { ...(defaultConfig().agent), ...(initial.agent ?? {}) },
    concurrency: { default: 4, ...(initial.concurrency ?? {}) },
  };
  let cur = structuredClone(merged);
  const saves: SubagentsConfig[] = [];
  return {
    io: {
      load: () => structuredClone(cur),
      save: (c) => {
        cur = structuredClone(c);
        saves.push(structuredClone(c));
      },
    },
    saves,
    current: () => cur,
  };
}

function navigatorStub(): { nav: AgentNavigator; calls: string[] } {
  const calls: string[] = [];
  const nav = {
    setStatsVisibility: (v: unknown) => calls.push(`setStatsVisibility:${JSON.stringify(v)}`),
  };
  return { nav: nav as unknown as AgentNavigator, calls };
}

function managerStub(): { m: AgentManager; concurrencies: unknown[] } {
  const concurrencies: unknown[] = [];
  const m = { setConcurrency: (c: unknown) => concurrencies.push(c) };
  return { m: m as unknown as AgentManager, concurrencies };
}

/* ------------------------------------------------------------------ */
/*  Reads & defaults                                                   */
/* ------------------------------------------------------------------ */

describe("ConfigStore reads", () => {
  it("bakes in scalar defaults when fields are absent", () => {
    const { io } = memIO({ agent: { forceBackground: false }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    expect(store.agent.graceTurns).toBe(6);
    expect(store.agent.showCost).toBe(false);
    expect(store.agent.forceBackground).toBe(false);
    expect(store.routing.enabled).toBe(false);
    expect(store.routing.allowedProviders).toEqual([]);
    expect(store.routing.agentModels).toEqual({});
  });

  it("returns configured values when present", () => {
    const { io } = memIO({
      modelRouting: { enabled: true, allowedProviders: ["openai"], agentModels: { Explore: "openai/gpt-4o" } },
      agent: { forceBackground: true, graceTurns: 9, showCost: true },
      concurrency: { default: 2 },
    });
    const store = new ConfigStore(io);
    expect(store.agent.graceTurns).toBe(9);
    expect(store.agent.showCost).toBe(true);
    expect(store.concurrency.default).toBe(2);
    expect(store.routing.enabled).toBe(true);
    expect(store.routing.allowedProviders).toEqual(["openai"]);
    expect(store.routing.agentModels).toEqual({ Explore: "openai/gpt-4o" });
  });

  it("concurrency providers/models default to {}", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.concurrency.providers).toEqual({});
    expect(store.concurrency.models).toEqual({});
  });

  it("routing getters return copies so callers cannot mutate the store", () => {
    const { io } = memIO({
      modelRouting: { enabled: true, allowedProviders: ["openai"], agentModels: { Explore: "openai/gpt-4o" } },
    });
    const store = new ConfigStore(io);
    store.routing.allowedProviders.push("xai");
    store.routing.agentModels["reviewer"] = "xai/grok-4";
    expect(store.routing.allowedProviders).toEqual(["openai"]);
    expect(store.routing.agentModels).toEqual({ Explore: "openai/gpt-4o" });
  });
});

/* ------------------------------------------------------------------ */
/*  Model resolution                                                   */
/* ------------------------------------------------------------------ */

describe("ConfigStore model resolution", () => {
  it("session assignment wins over persistent and frontmatter", () => {
    const { io } = memIO({
      modelRouting: { enabled: true, allowedProviders: [], agentModels: { Explore: "persistent/explore" } },
      agent: { forceBackground: false },
      concurrency: { default: 4 },
    });
    const store = new ConfigStore(io);
    store.mutate.session.setOverride("Explore", "session/explore");
    expect(store.modelSelectionFor("Explore", "parent", { model: "frontmatter" }))
      .toEqual({ model: "session/explore", source: "automatic" });
  });

  it("falls through persistent -> frontmatter -> parent", () => {
    const { io } = memIO({
      modelRouting: { enabled: true, allowedProviders: [], agentModels: { Explore: "persistent/explore" } },
      agent: { forceBackground: false },
      concurrency: { default: 4 },
    });
    const store = new ConfigStore(io);
    expect(store.modelSelectionFor("Explore", "parent", { model: "frontmatter" }))
      .toEqual({ model: "persistent/explore", source: "automatic" });
    expect(store.modelSelectionFor("reviewer", "parent", { model: "frontmatter" }))
      .toEqual({ model: "frontmatter", source: "automatic" });
  });

  it("returns parentModelId when nothing is assigned", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.modelSelectionFor("Explore", "parent/model"))
      .toEqual({ model: "parent/model", source: "parent" });
  });
});

/* ------------------------------------------------------------------ */
/*  Persisted mutations — behavioral tests                              */
/* ------------------------------------------------------------------ */

describe("ConfigStore persisted mutations", () => {
  it("setShowCost persists and syncs stats visibility to the navigator", () => {
    const { io, saves } = memIO();
    const { nav, calls } = navigatorStub();
    const store = new ConfigStore(io);
    store.setDeps({ navigator: nav });
    calls.length = 0;
    saves.length = 0;

    store.mutate.agent.setShowCost(true);
    expect(store.agent.showCost).toBe(true);
    expect(saves).toHaveLength(1);
    expect(saves[0].agent.showCost).toBe(true);
    expect(calls.some(c => c.includes('"showCost":true'))).toBe(true);
  });

  it("concurrency setters persist and call manager.setConcurrency", () => {
    const { io, saves } = memIO();
    const { m, concurrencies } = managerStub();
    const store = new ConfigStore(io);
    store.setDeps({ manager: m });
    concurrencies.length = 0;

    store.mutate.concurrency.setDefault(8);
    store.mutate.concurrency.setProvider("llamacpp", 2);
    store.mutate.concurrency.setModel("anthropic/claude", 3);

    expect(store.concurrency.default).toBe(8);
    expect(store.concurrency.providers).toEqual({ llamacpp: 2 });
    expect(store.concurrency.models).toEqual({ "anthropic/claude": 3 });
    expect(saves).toHaveLength(3);
    expect(concurrencies).toHaveLength(3);
  });

  it("removeProvider / removeModel delete and re-sync", () => {
    const { io } = memIO({ agent: { forceBackground: false }, concurrency: { default: 4, providers: { llamacpp: 2 }, models: { "a/b": 1 } } });
    const { m } = managerStub();
    const store = new ConfigStore(io);
    store.setDeps({ manager: m });
    store.mutate.concurrency.removeProvider("llamacpp");
    store.mutate.concurrency.removeModel("a/b");
    expect(store.concurrency.providers).toEqual({});
    expect(store.concurrency.models).toEqual({});
  });

  it("resetConcurrency restores defaults and re-syncs", () => {
    const { io } = memIO({ agent: { forceBackground: false }, concurrency: { default: 4, providers: { x: 1 } } });
    const store = new ConfigStore(io);
    store.mutate.concurrency.reset();
    expect(store.concurrency.default).toBe(4);
    expect(store.concurrency.providers).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/*  Routing policy mutations                                            */
/* ------------------------------------------------------------------ */

describe("ConfigStore routing mutations", () => {
  it("setEnabled toggles the routing switch and persists", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);
    store.mutate.routing.setEnabled(true);
    expect(store.routing.enabled).toBe(true);
    expect(saves).toHaveLength(1);
    expect(saves[0].modelRouting.enabled).toBe(true);
  });

  it("setProviderAllowed adds and removes providers from the allowlist", () => {
    const { io } = memIO();
    const store = new ConfigStore(io);
    store.mutate.routing.setProviderAllowed("openai", true);
    store.mutate.routing.setProviderAllowed("google", true);
    expect(store.routing.allowedProviders.sort()).toEqual(["google", "openai"]);
    store.mutate.routing.setProviderAllowed("openai", false);
    expect(store.routing.allowedProviders).toEqual(["google"]);
  });

  it("removeProvider clears the allowlist entry and every assignment using it", () => {
    const { io, saves } = memIO({
      modelRouting: {
        enabled: true,
        allowedProviders: ["openai", "google"],
        agentModels: {
          Explore: "openai/gpt-4o",
          researcher: "openai/gpt-5",
          reviewer: "google/gemini-2.5-pro",
        },
      },
    });
    const store = new ConfigStore(io);
    store.mutate.routing.removeProvider("openai");
    expect(store.routing.allowedProviders).toEqual(["google"]);
    expect(store.routing.agentModels).toEqual({ reviewer: "google/gemini-2.5-pro" });
    expect(saves).toHaveLength(1);
  });

  it("setAgentModel sets, updates, and clears (null) a persistent assignment", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);
    store.mutate.routing.setAgentModel("Explore", "openai/gpt-4o");
    expect(store.routing.agentModels).toEqual({ Explore: "openai/gpt-4o" });
    store.mutate.routing.setAgentModel("Explore", null);
    expect(store.routing.agentModels).toEqual({});
    expect(saves).toHaveLength(2);
  });

  it("clearAll resets the allowlist, assignments, and switch", () => {
    const { io, saves } = memIO({
      modelRouting: {
        enabled: true,
        allowedProviders: ["openai"],
        agentModels: { Explore: "openai/gpt-4o" },
      },
    });
    const store = new ConfigStore(io);
    store.mutate.routing.clearAll();
    expect(store.routing).toEqual({ enabled: false, allowedProviders: [], agentModels: {} });
    expect(saves).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  Session overrides                                                   */
/* ------------------------------------------------------------------ */

describe("ConfigStore session overrides", () => {
  it("are not persisted", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);
    saves.length = 0;
    store.mutate.session.setOverride("Explore", "session/model");
    store.mutate.session.clearOverride("Explore");
    store.mutate.session.clearAll();
    expect(saves).toHaveLength(0);
  });

  it("are readable and affect modelSelectionFor", () => {
    const store = new ConfigStore(memIO().io);
    store.mutate.session.setOverride("Explore", "session/explore");
    expect(store.sessionModelOverride("Explore")).toBe("session/explore");
    expect(store.modelSelectionFor("Explore", "parent"))
      .toEqual({ model: "session/explore", source: "automatic" });
  });

  it("clearAll resets to an empty map", () => {
    const store = new ConfigStore(memIO().io);
    store.mutate.session.setOverride("Explore", "x");
    store.mutate.session.setOverride("reviewer", "y");
    store.mutate.session.clearAll();
    expect(store.sessionModelOverride("Explore")).toBeNull();
    expect(store.sessionModelOverride("reviewer")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Generic agent properties — defaults, configured, persist, preserve  */
/* ------------------------------------------------------------------ */

describe("ConfigStore agent properties", () => {
  it("boolean properties default correctly", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.agent.includeContextFiles).toBe(true);
    expect(store.agent.loadSkillsImplicitly).toBe(true);
    expect(store.agent.loadExtensionsImplicitly).toBe(true);
    expect(store.agent.disableDefaultAgents).toBe(false);
  });

  it("string property defaults to 'replace'", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.agent.systemPromptMode).toBe("replace");
  });

  it("optional thinking defaults to undefined", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.agent.defaultThinking).toBeUndefined();
  });

  it("configured values override defaults", () => {
    const { io } = memIO({
      modelRouting: { enabled: true, allowedProviders: [], agentModels: {} },
      agent: { forceBackground: false, includeContextFiles: false, systemPromptMode: "custom", defaultThinking: "high", loadSkillsImplicitly: false, loadExtensionsImplicitly: false, disableDefaultAgents: true },
      concurrency: { default: 4 },
    });
    const store = new ConfigStore(io);
    expect(store.agent.includeContextFiles).toBe(false);
    expect(store.routing.enabled).toBe(true);
    expect(store.agent.systemPromptMode).toBe("custom");
    expect(store.agent.defaultThinking).toBe("high");
    expect(store.agent.loadSkillsImplicitly).toBe(false);
    expect(store.agent.loadExtensionsImplicitly).toBe(false);
    expect(store.agent.disableDefaultAgents).toBe(true);
  });

  it("setters persist values", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);

    store.mutate.agent.setIncludeContextFiles(false);
    store.mutate.agent.setSystemPromptMode("custom");
    store.mutate.agent.setDefaultThinking("medium");
    store.mutate.agent.setLoadSkillsImplicitly(false);
    store.mutate.agent.setLoadExtensionsImplicitly(false);
    store.mutate.agent.setDisableDefaultAgents(true);

    expect(store.agent.includeContextFiles).toBe(false);
    expect(store.agent.systemPromptMode).toBe("custom");
    expect(store.agent.defaultThinking).toBe("medium");
    expect(store.agent.loadSkillsImplicitly).toBe(false);
    expect(store.agent.loadExtensionsImplicitly).toBe(false);
    expect(store.agent.disableDefaultAgents).toBe(true);
    expect(saves).toHaveLength(6);
  });

  it("setDefaultThinking(undefined) removes the field", () => {
    const { io } = memIO({ agent: { forceBackground: false, defaultThinking: "high" }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    store.mutate.agent.setDefaultThinking(undefined);
    expect(store.agent.defaultThinking).toBeUndefined();
  });

  it("agent settings are never used to store model choices", () => {
    const { io } = memIO({
      modelRouting: { enabled: true, allowedProviders: ["openai"], agentModels: { Explore: "openai/gpt-4o" } },
      agent: { forceBackground: false },
    });
    const store = new ConfigStore(io);
    expect(store.agent.forceBackground).toBe(false);
    expect((store as any).config.agent.Explore).toBeUndefined();
    expect(store.routing.agentModels.Explore).toBe("openai/gpt-4o");
  });
});

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                           */
/* ------------------------------------------------------------------ */

describe("ConfigStore lifecycle", () => {
  it("reload re-reads disk and resets session assignments", () => {
    const { io, current } = memIO();
    const store = new ConfigStore(io);
    store.mutate.session.setOverride("Explore", "session/explore");
    store.mutate.agent.setGraceTurns(11);

    current().agent.graceTurns = 5;
    store.reload();

    expect(store.agent.graceTurns).toBe(5);
    expect(store.sessionModelOverride("Explore")).toBeNull();
  });

  it("reload resynchronizes navigator visibility", () => {
    const { io } = memIO({ agent: { forceBackground: false, showCost: true }, concurrency: { default: 4 } });
    const { nav, calls } = navigatorStub();
    const store = new ConfigStore(io);
    store.setDeps({ navigator: nav });
    calls.length = 0;
    store.reload();
    expect(calls.some(c => c.includes('"showCost":true'))).toBe(true);
  });

  it("setDeps immediately syncs the navigator from current config", () => {
    const { io } = memIO({ agent: { forceBackground: false, showTools: false }, concurrency: { default: 4 } });
    const { nav, calls } = navigatorStub();
    const store = new ConfigStore(io);
    store.setDeps({ navigator: nav });
    expect(calls.some(c => c.includes('"showTools":false'))).toBe(true);
  });

  it("dispose drops deps so mutations no longer sync", () => {
    const { io } = memIO();
    const { nav, calls } = navigatorStub();
    const store = new ConfigStore(io);
    store.setDeps({ navigator: nav });
    store.dispose();
    calls.length = 0;
    store.mutate.agent.setShowCost(true);
    expect(calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  show* stats visibility                                               */
/* ------------------------------------------------------------------ */

describe("ConfigStore show* stats visibility", () => {
  it("all show* keys default to true", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.agent.showTools).toBe(true);
    expect(store.agent.showTurns).toBe(true);
    expect(store.agent.showInput).toBe(true);
    expect(store.agent.showOutput).toBe(true);
    expect(store.agent.showContext).toBe(true);
    expect(store.agent.showTime).toBe(true);
  });

  it("configured false values are respected", () => {
    const { io } = memIO({
      agent: { forceBackground: false, showTools: false, showTurns: false, showInput: false, showOutput: false, showContext: false, showTime: false },
      concurrency: { default: 4 },
    });
    const store = new ConfigStore(io);
    expect(store.agent.showTools).toBe(false);
    expect(store.agent.showTurns).toBe(false);
    expect(store.agent.showInput).toBe(false);
    expect(store.agent.showOutput).toBe(false);
    expect(store.agent.showContext).toBe(false);
    expect(store.agent.showTime).toBe(false);
  });

  it("setShowTools persists and syncs to the navigator", () => {
    const { io, saves } = memIO();
    const { nav, calls } = navigatorStub();
    const store = new ConfigStore(io);
    store.setDeps({ navigator: nav });
    calls.length = 0;
    saves.length = 0;

    store.mutate.agent.setShowTools(false);
    expect(store.agent.showTools).toBe(false);
    expect(saves).toHaveLength(1);
    expect(calls.some(c => c.includes('"showTools":false'))).toBe(true);
  });

  it("reload syncs visibility to the navigator", () => {
    const { io } = memIO({ agent: { forceBackground: false, showTools: false }, concurrency: { default: 4 } });
    const { nav, calls } = navigatorStub();
    const store = new ConfigStore(io);
    store.setDeps({ navigator: nav });
    calls.length = 0;
    store.reload();
    expect(calls.some(c => c.startsWith("setStatsVisibility:"))).toBe(true);
  });
});
