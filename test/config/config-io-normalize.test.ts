import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
vi.mock("node:fs", () => ({
  readFileSync: (path: string) => {
    if (!files.has(path)) throw new Error("ENOENT");
    return files.get(path);
  },
  writeFileSync: (path: string, data: string) => { files.set(path, data); },
  renameSync: (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
  mkdirSync: () => {},
}));

const CONFIG_PATH = join(process.env.HOME || "", ".pi", "agent", "subagents-lite.json");
import { loadConfig, saveConfigAtomic } from "../../src/config/config-io.js";

function writeConfig(value: unknown): void {
  files.set(CONFIG_PATH, JSON.stringify(value));
}

describe("config-io model access normalization", () => {
  beforeEach(() => files.clear());

  it("drops the retired background delivery policy from canonical settings", () => {
    writeConfig({ agent: { backgroundDelivery: "next-turn", graceTurns: 9 } });
    const config = loadConfig();

    expect(config.agent.graceTurns).toBe(9);
    expect(config.agent).not.toHaveProperty("backgroundDelivery");

    saveConfigAtomic(config);
    expect(JSON.parse(files.get(CONFIG_PATH)!).agent).not.toHaveProperty("backgroundDelivery");
  });

  it("defaults list expansion on and preserves explicit off", () => {
    writeConfig({});
    expect(loadConfig().agent.expandListByDefault).toBe(true);

    writeConfig({ agent: { expandListByDefault: false } });
    expect(loadConfig().agent.expandListByDefault).toBe(false);
  });

  it("returns fresh routing defaults for missing and malformed blocks", () => {
    for (const value of [{}, { modelRouting: null }, { modelRouting: [] }, { modelRouting: "on" }]) {
      writeConfig(value);
      expect(loadConfig().modelRouting).toEqual({ enabled: false, enabledProviders: [], agentAccess: {} });
    }
    const first = loadConfig();
    first.modelRouting.enabledProviders.push("openai");
    first.modelRouting.agentAccess.Explore = { providers: { openai: {} } };
    expect(loadConfig().modelRouting).toEqual({ enabled: false, enabledProviders: [], agentAccess: {} });
  });

  it("only accepts true for enabled", () => {
    writeConfig({ modelRouting: { enabled: true } });
    expect(loadConfig().modelRouting.enabled).toBe(true);
    for (const enabled of [false, "true", 1, null]) {
      writeConfig({ modelRouting: { enabled } });
      expect(loadConfig().modelRouting.enabled).toBe(false);
    }
  });

  it("normalizes enabled provider IDs", () => {
    writeConfig({ modelRouting: { enabledProviders: [" openai ", "", 4, "openai", "google"] } });
    expect(loadConfig().modelRouting.enabledProviders).toEqual(["openai", "google"]);

    writeConfig({ modelRouting: { enabledProviders: "openai" } });
    expect(loadConfig().modelRouting.enabledProviders).toEqual([]);
  });

  it("normalizes all-model and exact-model access rules", () => {
    writeConfig({
      modelRouting: {
        enabled: true,
        enabledProviders: ["openai", "google"],
        agentAccess: {
          " Explore ": {
            providers: {
              " openai ": {},
              google: { models: [" gemini-pro ", "", "gemini-pro", "gemini-flash", 4] },
            },
          },
        },
      },
    });
    expect(loadConfig().modelRouting).toEqual({
      enabled: true,
      enabledProviders: ["openai", "google"],
      agentAccess: {
        Explore: {
          providers: {
            openai: {},
            google: { models: ["gemini-pro", "gemini-flash"] },
          },
        },
      },
    });
  });

  it("drops empty, malformed, and invalid exact rules instead of widening them", () => {
    writeConfig({
      modelRouting: {
        agentAccess: {
          empty: { providers: { openai: { models: [] } } },
          blanks: { providers: { openai: { models: [" "] } } },
          badModels: { providers: { openai: { models: "gpt" } } },
          misspelledModels: { providers: { openai: { model: ["gpt-5"] } } },
          badProvider: { providers: { openai: null } },
          badProviders: { providers: [] },
          " ": { providers: { openai: {} } },
        },
      },
    });
    expect(loadConfig().modelRouting.agentAccess).toEqual({});
  });

  it("preserves prototype-like IDs only as explicit own rules", () => {
    files.set(CONFIG_PATH, JSON.stringify({
      modelRouting: {
        agentAccess: JSON.parse('{"constructor":{"providers":{"__proto__":{"models":["worker"]}}}}'),
      },
    }));
    const access = loadConfig().modelRouting.agentAccess;
    expect(Object.hasOwn(access, "constructor")).toBe(true);
    expect(Object.hasOwn(access.constructor.providers, "__proto__")).toBe(true);
    expect(access.constructor.providers.__proto__).toEqual({ models: ["worker"] });
  });

  it("keeps dormant rules for providers outside enabledProviders", () => {
    writeConfig({
      modelRouting: {
        enabled: false,
        enabledProviders: [],
        agentAccess: { Explore: { providers: { openai: { models: ["gpt-5"] } } } },
      },
    });
    expect(loadConfig().modelRouting.agentAccess.Explore.providers.openai).toEqual({ models: ["gpt-5"] });
  });

  it("normalizes Parent model access and exact-model thinking overrides", () => {
    writeConfig({
      modelRouting: {
        agentAccess: {
          Explore: {
            parentModelAccess: false,
            providers: {},
            thinking: {
              " openai/gpt-5 ": {
                allowed: [" high ", "low", "high"],
                default: "low",
              },
            },
          },
        },
      },
    });
    expect(loadConfig().modelRouting.agentAccess).toEqual({
      Explore: {
        parentModelAccess: false,
        providers: {},
        thinking: {
          "openai/gpt-5": { allowed: ["high", "low"], default: "low" },
        },
      },
    });
  });

  it("drops malformed thinking overrides without deleting other Agent access", () => {
    writeConfig({
      modelRouting: {
        agentAccess: {
          Explore: {
            parentModelAccess: false,
            providers: { openai: {} },
            thinking: {
              bare: { allowed: ["low"], default: "low" },
              "openai/empty": { allowed: [], default: "low" },
              "openai/unknown": { allowed: ["provider-custom"], default: "provider-custom" },
              "openai/missing-default": { allowed: ["low"], default: "high" },
              "openai/malformed": null,
            },
          },
        },
      },
    });
    expect(loadConfig().modelRouting.agentAccess).toEqual({
      Explore: {
        parentModelAccess: false,
        providers: { openai: {} },
      },
    });
  });

  it("silently ignores retired global defaultThinking", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ agent: { defaultThinking: "xhigh", graceTurns: 9 } });
    const config = loadConfig();
    expect(config.agent.graceTurns).toBe(9);
    expect(config.agent).not.toHaveProperty("defaultThinking");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("ignores assignment-era routing fields without migration", () => {
    writeConfig({
      modelRouting: {
        enabled: true,
        allowedProviders: ["openai"],
        agentModels: { Explore: "openai/gpt-5" },
      },
      allowCrossProvider: true,
      agent: { default: "openai/gpt-5", Explore: "openai/gpt-5", graceTurns: 9 },
    });
    const config = loadConfig();
    expect(config.modelRouting).toEqual({ enabled: true, enabledProviders: [], agentAccess: {} });
    expect(config.agent.graceTurns).toBe(9);
    expect(config.agent).not.toHaveProperty("default");
    expect(config.agent).not.toHaveProperty("Explore");
  });

  it("preserves non-model settings and saves only canonical routing fields", () => {
    writeConfig({
      modelRouting: { enabled: true, allowedProviders: ["openai"] },
      agent: { forceBackground: true, systemPromptMode: "custom" },
      concurrency: { default: 7 },
    });
    const config = loadConfig();
    expect(config.agent.forceBackground).toBe(true);
    expect(config.agent.systemPromptMode).toBe("custom");
    expect(config.concurrency.default).toBe(7);

    saveConfigAtomic(config);
    const saved = JSON.parse(files.get(CONFIG_PATH)!);
    expect({ sections: Object.keys(saved), revision: saved.revision }).toEqual({
      sections: ["modelRouting", "agent", "concurrency"],
      revision: undefined,
    });
    expect(saved.modelRouting).toEqual({
      enabled: true,
      enabledProviders: [],
      agentAccess: {},
    });
  });

  it("survives the JSON literal null", () => {
    files.set(CONFIG_PATH, "null");
    expect(loadConfig().modelRouting).toEqual({ enabled: false, enabledProviders: [], agentAccess: {} });
  });
});
