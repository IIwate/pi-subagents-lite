import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../../src/config/config-store.js";
import { createTestHarness, type TestHarness } from "../support/harness.js";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));

describe("configuration persistence", () => {
  let harness: TestHarness;
  let directory: string;
  let config: typeof import("../../src/config/config-io.js");
  let store: ConfigStore;

  beforeEach(async () => {
    harness = createTestHarness();
    directory = harness.createTempDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", directory);
    vi.resetModules();
    config = await import("../../src/config/config-io.js");
    expect(config.CONFIG_PATH).toBe(join(directory, "subagents-lite-v3.json"));
    config.saveConfigAtomic(harness.memIO.current());
    store = new ConfigStore({ load: config.loadConfig, save: config.saveConfigAtomic });
    harness.onDispose(() => store.dispose());
  });
  afterEach(async () => { await harness.dispose(); });

  it("uses the Pi agent directory for both settings and custom prompts", () => {
    expect(config.CONFIG_PATH).toBe(join(directory, "subagents-lite-v3.json"));
    expect(config.CUSTOM_PROMPT_PATH).toBe(join(directory, "subagents-lite-prompt.md"));
    store.mutate.agent.setForceBackground(true);
    expect(config.loadConfig().agent.forceBackground).toBe(true);
    expect(JSON.parse(fs.readFileSync(config.CONFIG_PATH, "utf-8")).agent.forceBackground).toBe(true);
  });

  it.each(["write", "rename"])("preserves disk and effective policy when %s fails", operation => {
    const original = fs.readFileSync(config.CONFIG_PATH, "utf-8");
    const setLimits = vi.fn();
    const setStatsVisibility = vi.fn();
    store.setDeps({ engine: { setLimits } as any, navigator: { setStatsVisibility } as any });
    const failure = new Error(`${operation} denied`);
    if (operation === "write") {
      const write = fs.writeFileSync;
      vi.spyOn(fs, "writeFileSync").mockImplementationOnce(file => {
        write(file, "partial write");
        throw failure;
      });
    } else {
      vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw failure; });
    }

    expect(() => store.mutate.concurrency.setDefault(8)).toThrow(failure);
    expect(fs.readFileSync(config.CONFIG_PATH, "utf-8")).toBe(original);
    expect(fs.readdirSync(directory)).toEqual(["subagents-lite-v3.json"]);
    expect(store.concurrency.default).toBe(4);
    expect(setLimits).toHaveBeenCalledOnce();
    expect(setStatsVisibility).toHaveBeenCalledOnce();

    store.mutate.concurrency.setDefault(2);
    expect(config.loadConfig().concurrency.default).toBe(2);
    expect(store.concurrency.default).toBe(2);
    expect(setLimits).toHaveBeenCalledTimes(2);
  });

  it.each([
    '{"concurrency":{"default":1e999}}', '{"concurrency":{"providers":{"test":0}}}',
    '{"agent":{"showCost":"yes"}}', 'null', '{',
  ])("preserves effective policy when loading invalid input %s", raw => {
    fs.writeFileSync(config.CONFIG_PATH, raw);
    expect(() => store.reload()).toThrow("Invalid subagent configuration");
    expect(store.concurrency.default).toBe(4);
  });
});
