/**
 * config-io-normalize.test.ts — New-schema runtime validation.
 *
 * Pre-2.0 routing shapes (allowCrossProvider, dynamic agent[type] model
 * keys, agent.default) are not migrated and not read. A missing or
 * malformed modelRouting block falls back to defaults; non-model agent and
 * concurrency fields still load normally; a bad config never breaks startup.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory node:fs for loadConfig/saveConfigAtomic (they target ~/.pi/agent).
const files = new Map<string, string>();
vi.mock("node:fs", () => ({
  readFileSync: (p: string) => {
    if (!files.has(p)) {
      const err: any = new Error(`ENOENT: no such file`);
      err.code = "ENOENT";
      throw err;
    }
    return files.get(p);
  },
  writeFileSync: (p: string, data: string) => { files.set(p, data); },
  renameSync: (a: string, b: string) => { files.set(b, files.get(a)!); files.delete(a); },
  mkdirSync: () => {},
  existsSync: () => true,
  readdirSync: () => [],
}));

const CONFIG_PATH = `${process.env.HOME || ""}/.pi/agent/subagents-lite.json`;
import { loadConfig, saveConfigAtomic } from "../../src/config/config-io.js";

describe("config-io new-schema normalization", () => {
  beforeEach(() => {
    files.clear();
  });

  function writeConfig(value: unknown): void {
    files.set(CONFIG_PATH, JSON.stringify(value));
  }

  it("returns defaults when modelRouting is missing entirely", () => {
    writeConfig({ agent: { graceTurns: 9 } });
    const config = loadConfig();
    expect(config.modelRouting).toEqual({ enabled: false, allowedProviders: [], agentModels: {} });
    // Non-model settings still read normally.
    expect(config.agent.graceTurns).toBe(9);
  });

  it("returns defaults when modelRouting is not a plain object", () => {
    writeConfig({ modelRouting: "enabled" });
    expect(loadConfig().modelRouting).toEqual({ enabled: false, allowedProviders: [], agentModels: {} });

    writeConfig({ modelRouting: 42 });
    expect(loadConfig().modelRouting).toEqual({ enabled: false, allowedProviders: [], agentModels: {} });
  });

  it("survives a config file that is the JSON literal null", () => {
    files.set(CONFIG_PATH, "null");
    const config = loadConfig();
    expect(config.modelRouting).toEqual({ enabled: false, allowedProviders: [], agentModels: {} });
    expect(config.agent.graceTurns).toBe(6);
    expect(config.concurrency.default).toBe(4);
  });

  it("only accepts true for enabled", () => {
    writeConfig({ modelRouting: { enabled: true } });
    expect(loadConfig().modelRouting.enabled).toBe(true);

    for (const bad of [false, "true", 1, null, undefined]) {
      writeConfig({ modelRouting: { enabled: bad } });
      expect(loadConfig().modelRouting.enabled).toBe(false);
    }
  });

  it("returns [] when allowedProviders is not an array", () => {
    for (const bad of ["openai", 42, null, {}, true]) {
      writeConfig({ modelRouting: { allowedProviders: bad } });
      expect(loadConfig().modelRouting.allowedProviders).toEqual([]);
    }
  });

  it("trims, drops empties, and dedupes allowedProviders", () => {
    writeConfig({
      modelRouting: {
        allowedProviders: [" openai ", "", "  ", "openai", "anthropic"],
      },
    });
    expect(loadConfig().modelRouting.allowedProviders).toEqual(["openai", "anthropic"]);
  });

  it("returns {} when agentModels is not a plain object", () => {
    for (const bad of [[], "openai/gpt-4o", 42, null, true]) {
      writeConfig({ modelRouting: { agentModels: bad } });
      expect(loadConfig().modelRouting.agentModels).toEqual({});
    }
  });

  it("ignores non-string or empty model values and empty type keys", () => {
    writeConfig({
      modelRouting: {
        agentModels: {
          "general-purpose": "openai/gpt-4o",
          researcher: 42,
          reviewer: null,
          "": "openai/gpt-5",
          "  ": "openai/gpt-5",
          explorer: "   ",
        },
      },
    });
    expect(loadConfig().modelRouting.agentModels).toEqual({ "general-purpose": "openai/gpt-4o" });
  });

  it("preserves a valid new-schema modelRouting block", () => {
    writeConfig({
      modelRouting: {
        enabled: true,
        allowedProviders: ["openai", "anthropic"],
        agentModels: { explorer: "openai/gpt-5", researcher: "anthropic/claude-4" },
      },
    });
    expect(loadConfig().modelRouting).toEqual({
      enabled: true,
      allowedProviders: ["openai", "anthropic"],
      agentModels: { explorer: "openai/gpt-5", researcher: "anthropic/claude-4" },
    });
  });

  it("reads non-model agent and concurrency fields normally", () => {
    writeConfig({
      modelRouting: { enabled: true },
      agent: { graceTurns: 12, forceBackground: true, systemPromptMode: "custom" },
      concurrency: { default: 6 },
    });
    const config = loadConfig();
    expect(config.agent.graceTurns).toBe(12);
    expect(config.agent.forceBackground).toBe(true);
    expect(config.agent.systemPromptMode).toBe("custom");
    expect(config.concurrency.default).toBe(6);
  });

  it("ignores legacy pre-2.0 routing fields without migrating them", () => {
    writeConfig({
      allowCrossProvider: true,
      agent: {
        default: "openai/gpt-4o",
        "general-purpose": "openai/gpt-5",
        researcher: "anthropic/claude-4",
      },
    });
    const config = loadConfig();
    expect(config.modelRouting).toEqual({ enabled: false, allowedProviders: [], agentModels: {} });
    expect(config.agent).not.toHaveProperty("default");
    expect(config.agent).not.toHaveProperty("researcher");
    // Non-model agent defaults still apply.
    expect(config.agent.graceTurns).toBe(6);
  });

  it("prunes legacy agent keys on the next save", () => {
    writeConfig({ agent: { default: "openai/gpt-4o", "general-purpose": "openai/gpt-5", graceTurns: 3 } });
    const config = loadConfig();
    saveConfigAtomic(config);
    const saved = JSON.parse(files.get(CONFIG_PATH)!);
    expect(saved.agent.graceTurns).toBe(3);
    expect(saved.agent).not.toHaveProperty("default");
    expect(saved.agent).not.toHaveProperty("general-purpose");
    expect(saved.modelRouting).toEqual({ enabled: false, allowedProviders: [], agentModels: {} });
  });
});
