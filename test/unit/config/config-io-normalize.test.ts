import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { createTestHarness, type TestHarness } from "../../support/harness.js";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));

const files = new Map<string, string>();

import { CONFIG_PATH, loadConfig, saveConfigAtomic } from "../../../src/config/config-io.js";

function writeConfig(value: unknown): void {
  files.set(CONFIG_PATH, JSON.stringify(value));
}

describe("config-io model access normalization", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = createTestHarness();
    files.clear();
    const descriptors = new Map<number, string>();
    vi.spyOn(fs, "readFileSync").mockImplementation(file => {
      if (!files.has(String(file))) throw new Error("ENOENT");
      return files.get(String(file))!;
    });
    vi.spyOn(fs, "openSync").mockImplementation(file => {
      const fd = descriptors.size + 1;
      descriptors.set(fd, String(file));
      return fd;
    });
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data) => {
      files.set(typeof file === "number" ? descriptors.get(file)! : String(file), String(data));
    });
    vi.spyOn(fs, "closeSync").mockImplementation(() => {});
    vi.spyOn(fs, "unlinkSync").mockImplementation(file => { files.delete(String(file)); });
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      files.set(String(to), files.get(String(from))!);
      files.delete(String(from));
    });
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
  });
  afterEach(async () => { await harness.dispose(); });

  it("bounds non-finite and malformed ceilings from external JSON", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    files.set(CONFIG_PATH, '{"agent":{"graceTurns":1e999},"concurrency":{"default":1e999,"providers":{"test":1e999},"models":{"test/model":"invalid","test/fraction":1.5,"test/zero":0}}}');
    expect(loadConfig()).toMatchObject({
      agent: { graceTurns: 6 },
      concurrency: { default: 4, providers: { test: 1 }, models: { "test/model": 1, "test/fraction": 2, "test/zero": 1 } },
    });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("concurrency.models.test/model"));
  });

  it.each([-1, 1.5, "8", null])("recovers an invalid grace budget: %s", graceTurns => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ agent: { graceTurns } });
    expect(loadConfig().agent.graceTurns).toBe(6);
    writeConfig({ agent: { graceTurns: 0 } });
    expect(loadConfig().agent.graceTurns).toBe(0);
  });

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
    expect(Object.hasOwn(access["constructor"].providers, "__proto__")).toBe(true);
    expect(access["constructor"].providers.__proto__).toEqual({ models: ["worker"] });
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
      agent: { forceBackground: true, systemPromptMode: "custom", expandListByDefault: false },
      concurrency: { default: 7 },
    });
    const config = loadConfig();
    expect(config.agent.forceBackground).toBe(true);
    expect(config.agent.systemPromptMode).toBe("custom");
    expect(config.agent.expandListByDefault).toBe(false);
    expect(config.concurrency.default).toBe(7);

    saveConfigAtomic(config);
    expect(JSON.parse(files.get(CONFIG_PATH)!).modelRouting).toEqual({
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
