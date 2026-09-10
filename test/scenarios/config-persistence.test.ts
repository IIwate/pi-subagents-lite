import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../../src/config/config-store.js";
import { AgentManager } from "../../src/agents/agent-manager.js";
import { runAgent } from "../../src/agents/agent-runner.js";
import { createTestHarness, type TestHarness } from "../support/harness.js";
import { fakeCtx, fakePi } from "../support/fixtures.js";
import { fakeOptions, mockRunResult } from "../support/manager.js";

vi.mock("../../src/agents/agent-runner.js", () => ({ runAgent: vi.fn(), continueAgentSession: vi.fn() }));
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
    expect(config.CONFIG_PATH).toBe(join(directory, "subagents-lite.json"));
    config.saveConfigAtomic(harness.memIO.current());
    store = new ConfigStore({ load: config.loadConfig, save: config.saveConfigAtomic });
    harness.onDispose(() => store.dispose());
  });
  afterEach(async () => { await harness.dispose(); });

  it("uses the Pi agent directory for both settings and custom prompts", () => {
    expect(config.CONFIG_PATH).toBe(join(directory, "subagents-lite.json"));
    expect(config.CUSTOM_PROMPT_PATH).toBe(join(directory, "subagents-lite-prompt.md"));
    store.mutate.agent.setForceBackground(true);
    expect(config.loadConfig().agent.forceBackground).toBe(true);
    expect(JSON.parse(fs.readFileSync(config.CONFIG_PATH, "utf-8")).agent.forceBackground).toBe(true);
  });

  it.each(["write", "rename"])("preserves disk and effective policy when %s fails", operation => {
    const original = fs.readFileSync(config.CONFIG_PATH, "utf-8");
    const setConcurrency = vi.fn();
    const setStatsVisibility = vi.fn();
    store.setDeps({ manager: { setConcurrency } as any, navigator: { setStatsVisibility } as any });
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
    expect(fs.readdirSync(directory)).toEqual(["subagents-lite.json"]);
    expect(store.concurrency.default).toBe(4);
    expect(setConcurrency).toHaveBeenCalledOnce();
    expect(setStatsVisibility).toHaveBeenCalledOnce();

    store.mutate.concurrency.setDefault(2);
    expect(config.loadConfig().concurrency.default).toBe(2);
    expect(store.concurrency.default).toBe(2);
    expect(setConcurrency).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "model", raw: '{"concurrency":{"default":1e999,"models":{"test/model":"invalid"}}}', secondModel: "test/model" },
    { name: "provider", raw: '{"concurrency":{"default":4,"providers":{"test":1e999}}}', secondModel: "test/other" },
  ])("keeps malformed $name ceilings effective at the scheduler boundary", async ({ raw, secondModel }) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(config.CONFIG_PATH, raw);
    store.reload();
    vi.mocked(runAgent).mockResolvedValue(mockRunResult());
    const manager = new AgentManager();
    harness.onDispose(() => manager.dispose());
    store.setDeps({ manager });
    const first = manager.spawn(fakePi(), fakeCtx(), "Explore", "first", fakeOptions({ modelKey: "test/model" }));
    const second = manager.spawn(fakePi(), fakeCtx(), "Explore", "second", fakeOptions({ modelKey: secondModel }));
    const firstRecord = manager.getRecord(first)!;
    const secondRecord = manager.getRecord(second)!;
    harness.onDispose(async () => {
      await firstRecord.execution.promise;
      await secondRecord.execution.promise;
    });
    expect(firstRecord.lifecycle.status).toBe("running");
    expect(secondRecord.lifecycle.status).toBe("queued");
    await firstRecord.execution.promise;
    await secondRecord.execution.promise;
  });
});
