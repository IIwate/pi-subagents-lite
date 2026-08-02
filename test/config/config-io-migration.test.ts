/**
 * config-io-migration.test.ts — One-time legacy config migration.
 *
 * Verifies that the pre-1.2 shape (allowCrossProvider, dynamic agent[type]
 * model keys, agent.default) normalizes to modelRouting, that old model
 * fields are pruned on save, and that no long-lived compat branch remains
 * in the persisted shape.
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
  renameSync: (_a: string, b: string) => { files.set(b, files.get(files.keys().next().value)!); },
  mkdirSync: () => {},
  existsSync: () => true,
  readdirSync: () => [],
}));

const CONFIG_PATH = `${process.env.HOME || ""}/.pi/agent/subagents-lite.json`;

import { loadConfig, saveConfigAtomic } from "../../src/config/config-io.js";

beforeEach(() => {
  vi.clearAllMocks();
  files.clear();
});

describe("legacy config migration", () => {
  it("maps allowCrossProvider to modelRouting.enabled", () => {
    files.set(CONFIG_PATH, JSON.stringify({
      allowCrossProvider: true,
      agent: { forceBackground: false },
      concurrency: { default: 4 },
    }));
    const config = loadConfig();
    expect(config.modelRouting.enabled).toBe(true);
    expect(config.modelRouting.allowedProviders).toEqual([]);
    expect(config.modelRouting.agentModels).toEqual({});
  });

  it("migrates dynamic agent[type] model keys into agentModels and extracts providers into the allowlist", () => {
    files.set(CONFIG_PATH, JSON.stringify({
      allowCrossProvider: false,
      agent: { forceBackground: true, Explore: "openai/gpt-4o", reviewer: "google/gemini-2.5-pro" },
      concurrency: { default: 4 },
    }));
    const config = loadConfig();
    expect(config.agent.forceBackground).toBe(true);
    expect(config.modelRouting.agentModels).toEqual({
      Explore: "openai/gpt-4o",
      reviewer: "google/gemini-2.5-pro",
    });
    expect([...config.modelRouting.allowedProviders].sort()).toEqual(["google", "openai"]);
  });

  it("drops retired agent.default with a warning and never migrates it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    files.set(CONFIG_PATH, JSON.stringify({
      allowCrossProvider: true,
      agent: { default: "anthropic/claude-sonnet-4", forceBackground: false },
      concurrency: { default: 4 },
    }));
    const config = loadConfig();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Legacy agent.default"));
    expect(config.modelRouting.agentModels.default).toBeUndefined();
    expect(config.modelRouting.allowedProviders).toEqual([]);
    expect(config.modelRouting.enabled).toBe(true);
    warn.mockRestore();
  });

  it("merges new-format modelRouting fields with legacy ones", () => {
    files.set(CONFIG_PATH, JSON.stringify({
      allowCrossProvider: true,
      modelRouting: { enabled: false, allowedProviders: ["xai"] },
      agent: { general: "openai/gpt-4o" },
      concurrency: { default: 4 },
    }));
    const config = loadConfig();
    expect(config.modelRouting.enabled).toBe(false); // explicit new field wins
    // new-format allowlist keeps xai; the legacy dynamic key adds its provider
    expect([...config.modelRouting.allowedProviders].sort()).toEqual(["openai", "xai"]);
    expect(config.modelRouting.agentModels).toEqual({ general: "openai/gpt-4o" });
  });
});

describe("save prunes legacy fields", () => {
  it("drops dynamic agent keys and retired default on save", () => {
    const config: any = {
      modelRouting: { enabled: true, allowedProviders: [], agentModels: {} },
      agent: { forceBackground: true, Explore: "openai/gpt-4o", default: "x" },
      concurrency: { default: 4 },
    };
    saveConfigAtomic(config);
    const saved = JSON.parse(files.get(CONFIG_PATH)!);
    expect(saved.agent).toEqual({ forceBackground: true });
    expect(saved.modelRouting).toEqual({ enabled: true, allowedProviders: [], agentModels: {} });
    expect(saved.concurrency).toEqual({ default: 4 });
  });
});
