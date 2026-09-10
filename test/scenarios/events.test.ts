import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureManagerAndNavigator, scanAndRegisterAgents } from "../../src/events.js";
import * as agentDiscovery from "../../src/agents/agent-discovery.js";
import * as agentRunner from "../../src/agents/agent-runner.js";
import { fakeCtx, fakePi } from "../support/fixtures.js";
import { fakeOptions, mockRunResult } from "../support/manager.js";
import { getAgentConfig, getAvailableTypes } from "../../src/agents/agent-types.js";
import {
  getManager,
  getCoordinator,
  getNavigator,
  getStore,
  setManager,
  setNavigator,
  setCoordinator,
  setSessionCtx,
} from "../../src/shell.js";

import { createTestHarness, type TestHarness } from "../support/harness.js";
import * as shell from "../../src/shell.js";

let harness: TestHarness;
beforeEach(() => {
  harness = createTestHarness();
  harness.onDispose(() => {
    setManager(null);
    setNavigator(null);
    setCoordinator(null);
    setSessionCtx(null!);
  });
  harness.onDispose(() => getCoordinator()?.dispose());
  harness.onDispose(async () => { await getManager()?.dispose(); });
  harness.onDispose(() => getNavigator()?.dispose());
});
afterEach(async () => { await harness.dispose(); });

it("discovers global agents from Pi's directory override while honoring project trust", async () => {
  const directory = harness.createTempDir();
  const project = harness.createTempDir();
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.spyOn(shell, "getStore").mockReturnValue(harness.store);
  const globalAgents = join(directory, "agents");
  const projectAgents = join(project, ".pi", "agents");
  mkdirSync(globalAgents);
  mkdirSync(projectAgents, { recursive: true });
  writeFileSync(join(globalAgents, "probe.md"), "---\r\nname: global-probe\r\n---\r\nGlobal prompt");
  writeFileSync(join(projectAgents, "probe.md"), "---\nname: project-probe\n---\nProject prompt");
  const scan = vi.spyOn(agentDiscovery, "scanAgentFilesInDir");
  await scanAndRegisterAgents({ cwd: project, isProjectTrusted: () => false } as any);
  expect(getAgentConfig("global-probe")?.systemPrompt).toBe("Global prompt");
  expect(getAgentConfig("project-probe")).toBeUndefined();
  expect(scan).not.toHaveBeenCalledWith(projectAgents, "project");
});

describe("ensureManagerAndNavigator", () => {
  beforeEach(() => {
    setSessionCtx({
      sessionManager: {
        getSessionId: () => "test-session",
        getSessionFile: () => undefined,
        getEntries: () => [],
        getBranch: () => [],
      },
    } as any);
    setManager(null);
    setNavigator(null);
    setCoordinator(null);
  });

  it("wires runner stats through the manager to navigator refresh", async () => {
    ensureManagerAndNavigator();

    const manager = getManager();
    const navigator = getNavigator();
    expect(manager).toBeDefined();
    expect(navigator).toBeDefined();

    const ensureTimerSpy = vi.spyOn(navigator!, "ensureTimer").mockImplementation(() => {});

    vi.spyOn(agentRunner, "runAgent").mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onToolUse?.();
      return mockRunResult();
    });
    const id = manager!.spawn(fakePi(), fakeCtx(), "general-purpose", "Inspect", fakeOptions());
    await manager!.getRecord(id)!.execution.promise;

    expect(ensureTimerSpy).toHaveBeenCalledTimes(1);
  });
});

describe("project trust during agent discovery", () => {
  let project: string;

  beforeEach(() => {
    project = harness.createTempDir();
    const agentDir = join(project, ".pi", "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "project-only.md"), "---\nname: project-only\ndescription: Project agent\n---\nProject instructions.");
    writeFileSync(join(agentDir, "shared-agent.md"), "---\nname: shared-agent\ndescription: Project override\n---\nProject override.");

    const scan = agentDiscovery.scanAgentFilesInDir;
    vi.spyOn(agentDiscovery, "scanAgentFilesInDir").mockImplementation((dir, source) => source === "user"
      ? Promise.resolve([{ name: "shared-agent", description: "Global agent", systemPrompt: "Global instructions.", source: "user" }])
      : scan(dir, source));
    const store = getStore();
    vi.spyOn(store, "agent", "get").mockReturnValue({ ...store.agent, disableDefaultAgents: false });
  });

  it("keeps built-in and global agents while excluding untrusted project definitions", async () => {
    await scanAndRegisterAgents({ cwd: project, isProjectTrusted: () => true } as any);
    expect(getAgentConfig("project-only")).toBeDefined();

    await scanAndRegisterAgents({ cwd: project, isProjectTrusted: () => false } as any);

    expect(getAvailableTypes()).toContain("general-purpose");
    expect(getAgentConfig("shared-agent")!.systemPrompt).toBe("Global instructions.");
    expect(getAgentConfig("project-only")).toBeUndefined();
  });

  it.each([true, undefined])("loads project agents when trust is %s", async trusted => {
    await scanAndRegisterAgents({
      cwd: project,
      isProjectTrusted: trusted === undefined ? undefined : () => trusted,
    } as any);

    expect(getAgentConfig("project-only")!.systemPrompt).toBe("Project instructions.");
    expect(getAgentConfig("shared-agent")!.systemPrompt).toBe("Project override.");
  });
});
