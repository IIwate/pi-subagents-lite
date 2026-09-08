import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureManagerAndNavigator, scanAndRegisterAgents, setupEventListeners } from "../src/events.js";
import * as agentDiscovery from "../src/agents/agent-discovery.js";
import * as agentRunner from "../src/agents/agent-runner.js";
import { fakeCtx, fakePi } from "./fixtures.js";
import { fakeOptions, mockRunResult } from "./agents/manager/manager-test-helpers.js";
import { getAgentConfig, getAvailableTypes, registerAgents, setAgentScanDirs } from "../src/agents/agent-types.js";
import {
  getManager,
  getCoordinator,
  getNavigator,
  getStore,
  setManager,
  setNavigator,
  setCoordinator,
  setSessionCtx,
} from "../src/shell.js";

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

  afterEach(async () => {
    getNavigator()?.dispose();
    await getManager()?.dispose();
    getCoordinator()?.dispose();
    setManager(null);
    setNavigator(null);
    setCoordinator(null);
    setSessionCtx(null as any);
    vi.restoreAllMocks();
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
    project = mkdtempSync(join(tmpdir(), "pi-agent-trust-"));
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

  afterEach(() => {
    vi.restoreAllMocks();
    setAgentScanDirs("", "", false);
    registerAgents(new Map());
    rmSync(project, { recursive: true, force: true });
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

describe("setupEventListeners session_shutdown notification", () => {
  let listeners: Array<{ event: string; handler: Function }>;
  let mockPi: any;
  let mockNotify: ReturnType<typeof vi.fn>;
  let mockCtx: any;

  beforeEach(() => {
    listeners = [];
    mockPi = {
      on: vi.fn((event: string, handler: Function) => {
        listeners.push({ event, handler });
      }),
    };
    mockNotify = vi.fn();
    mockCtx = {
      hasUI: true,
      ui: { notify: mockNotify },
    };
    setupEventListeners(mockPi);
  });

  afterEach(() => {
    setManager(null);
    setNavigator(null);
    setCoordinator(null);
    setSessionCtx(null as any);
  });

  it("notifies 'killed by reload' only when reason is reload", async () => {
    const mockManager: any = {
      listAgents: vi.fn(() => [
        { lifecycle: { status: "running" } },
        { lifecycle: { status: "queued" } },
      ]),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    setManager(mockManager);

    const shutdownListener = listeners.find((l) => l.event === "session_shutdown")?.handler;
    expect(shutdownListener).toBeDefined();

    await shutdownListener!({ type: "session_shutdown", reason: "reload" }, mockCtx);

    expect(mockNotify).toHaveBeenCalledWith("2 agent(s) killed by reload", "warning");
  });

  it("notifies 'stopped on session close' when reason is quit or non-reload", async () => {
    const mockManager: any = {
      listAgents: vi.fn(() => [{ lifecycle: { status: "running" } }]),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    setManager(mockManager);

    const shutdownListener = listeners.find((l) => l.event === "session_shutdown")?.handler;
    expect(shutdownListener).toBeDefined();

    await shutdownListener!({ type: "session_shutdown", reason: "quit" }, mockCtx);

    expect(mockNotify).toHaveBeenCalledWith("1 agent(s) stopped on session close", "warning");
  });

  it("does not notify when there are no active agents", async () => {
    const mockManager: any = {
      listAgents: vi.fn(() => [{ lifecycle: { status: "completed" } }]),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    setManager(mockManager);

    const shutdownListener = listeners.find((l) => l.event === "session_shutdown")?.handler;
    expect(shutdownListener).toBeDefined();

    await shutdownListener!({ type: "session_shutdown", reason: "reload" }, mockCtx);

    expect(mockNotify).not.toHaveBeenCalled();
  });
});
