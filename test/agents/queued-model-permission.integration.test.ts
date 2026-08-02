import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state: any = {};
  state.resetPrompt = () => {
    state.firstPrompt = new Promise<void>((resolve) => { state.releaseFirst = resolve; });
  };
  state.resetPrompt();
  const session = {
    model: { provider: "parent", id: "worker-model" },
    thinkingLevel: "high",
    agent: { onPayload: undefined as undefined | ((payload: unknown) => unknown) },
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
    getAllTools: vi.fn(() => []),
    setActiveToolsByName: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(() => state.firstPrompt),
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  return Object.assign(state, {
    session,
    createAgentSession: vi.fn(async () => ({ session, extensionsResult: {} })),
    routingEnabled: true as boolean,
    allowedProviders: [] as string[],
    store: {
      agent: {
        defaultThinking: "high",
        graceTurns: 2,
        forceBackground: false,
        loadSkillsImplicitly: true,
        loadExtensionsImplicitly: true,
        includeContextFiles: false,
      },
      get routing() {
        return {
          enabled: state.routingEnabled,
          allowedProviders: [...state.allowedProviders],
          agentModels: {},
        };
      },
      modelSelectionFor: vi.fn(() => ({ model: "parent/worker-model", source: "automatic" })),
    },
    coordinator: undefined as any,
    manager: undefined as any,
    ctx: undefined as any,
    pi: { exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })) } as any,
  });
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: mocks.createAgentSession,
  DefaultResourceLoader: class {
    async reload() {}
    getExtensions() { return { extensions: [] }; }
  },
  getAgentDir: () => "/tmp/pi-agent",
  loadProjectContextFiles: () => [],
  SessionManager: {
    inMemory: () => ({ appendCustomEntry: vi.fn() }),
  },
  SettingsManager: {
    create: () => ({}),
  },
}));

vi.mock("../../src/agents/agent-types.js", () => {
  const config = {
    name: "general-purpose",
    displayName: "Agent",
    description: "Test agent",
    systemPrompt: "Complete the task.",
    model: "parent/worker-model",
    registeredTools: [],
  };
  return {
    discoverNewAgents: vi.fn(async () => {}),
    resolveType: vi.fn(() => "general-purpose"),
    getAgentConfig: vi.fn(() => config),
    getConfig: vi.fn(() => config),
    getToolNamesForType: vi.fn(() => []),
    resolveSessionAllowedTools: vi.fn(() => []),
    resolveVisibleTools: vi.fn(() => []),
  };
});

vi.mock("../../src/shell.js", () => ({
  getStore: () => mocks.store,
  getCoordinator: () => mocks.coordinator,
  getManager: () => mocks.manager,
  getNavigator: () => undefined,
  getWidget: () => undefined,
  getPiInstance: () => mocks.pi,
  getSessionCtx: () => mocks.ctx,
  enterSubagentSpawn: vi.fn(),
  exitSubagentSpawn: vi.fn(),
}));

import { AgentManager } from "../../src/agents/agent-manager.js";
import { executeAgentTool } from "../../src/agents/tool-execution.js";
import { SpawnCoordinator } from "../../src/spawn/spawn-coordinator.js";

function params(description: string, model?: string) {
  return {
    agent: "general-purpose",
    prompt: description,
    description,
    run_in_background: true,
    ...(model ? { model } : {}),
  };
}

describe("queued automatic model permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resetPrompt();
    mocks.routingEnabled = true;
    mocks.allowedProviders = ["other"];
    mocks.ctx = {
      cwd: "/tmp/project",
      model: { provider: "parent", id: "main-model" },
      modelRegistry: {
        find: vi.fn((provider: string, id: string) => ({ provider, id })),
        getAvailable: vi.fn(() => []),
      },
      scopedModels: [
        { model: { provider: "parent", id: "main-model" } },
        { model: { provider: "parent", id: "worker-model" } },
      ],
      sessionManager: { getBranch: () => [] },
      getSystemPrompt: () => "Parent prompt",
      ui: { notify: vi.fn() },
    };
    mocks.manager = new AgentManager(undefined, { default: 1 });
    mocks.coordinator = new SpawnCoordinator(mocks.manager);
  });

  it.each([
    ["same-provider automatic override", "parent", false],
    ["cross-provider automatic override", "other", false],
    ["cross-provider explicit model", "other", true],
  ])("rechecks permission for a queued %s before creating the child session", async (_label, workerProvider, explicit) => {
    const selectedModel = `${workerProvider}/worker-model`;
    mocks.store.modelSelectionFor.mockReturnValue({ model: selectedModel, source: "automatic" });
    mocks.session.model = { provider: workerProvider, id: "worker-model" };
    mocks.ctx.scopedModels[1] = { model: { provider: workerProvider, id: "worker-model" } };

    await executeAgentTool("call-first", params("first", explicit ? selectedModel : undefined), undefined, undefined, mocks.ctx);
    await executeAgentTool("call-second", params("second", explicit ? selectedModel : undefined), undefined, undefined, mocks.ctx);

    const records = mocks.manager.listAgents();
    const first = records.find(record => record.display.description === "first")!;
    const second = records.find(record => record.display.description === "second")!;
    expect(first.lifecycle.status).toBe("running");
    expect(second.lifecycle.status).toBe("queued");

    mocks.routingEnabled = false;
    mocks.releaseFirst();
    await first.execution.promise;
    await vi.waitFor(() => expect(second.lifecycle.status).toBe("error"));

    expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
    expect(second.error).toContain(explicit ? "Cross-provider routing is OFF" : "Automatic model override");

    mocks.coordinator.dispose();
    await mocks.manager.dispose();
  });

  it("keeps the enqueue-time model when an assignment changes while queued", async () => {
    let selectedModel = "parent/worker-a:high";
    mocks.store.modelSelectionFor.mockImplementation(() => ({ model: selectedModel, source: "automatic" }));
    mocks.ctx.modelRegistry.find = vi.fn((provider: string, id: string) => ({ provider, id }));
    mocks.ctx.scopedModels.push(
      { model: { provider: "parent", id: "worker-a" } },
    );

    await executeAgentTool("call-first", params("first"), undefined, undefined, mocks.ctx);
    await vi.waitFor(() => expect(mocks.createAgentSession).toHaveBeenCalledTimes(1));
    await executeAgentTool("call-second", params("second"), undefined, undefined, mocks.ctx);

    // The assignment changes while the second agent is queued, but the model
    // was locked at enqueue time — no re-resolution happens at start.
    selectedModel = "other/worker-b:low";
    mocks.session.model = { provider: "other", id: "worker-b" };
    mocks.releaseFirst();
    await Promise.all(mocks.manager.listAgents().map(record => record.execution.promise));

    expect(mocks.createAgentSession).toHaveBeenCalledTimes(2);
    expect(mocks.createAgentSession.mock.calls[1][0].model).toEqual({
      provider: "parent",
      id: "worker-a",
    });
    expect(mocks.createAgentSession.mock.calls[1][0].thinkingLevel).toBe("high");

    mocks.coordinator.dispose();
    await mocks.manager.dispose();
  });

  it("fails a queued agent with the same model key when its provider is revoked", async () => {
    const selectedModel = "other/worker-model";
    mocks.store.modelSelectionFor.mockReturnValue({ model: selectedModel, source: "automatic" });
    mocks.session.model = { provider: "other", id: "worker-model" };
    mocks.ctx.scopedModels[1] = { model: { provider: "other", id: "worker-model" } };

    await executeAgentTool("call-first", params("first", selectedModel), undefined, undefined, mocks.ctx);
    await vi.waitFor(() => expect(mocks.createAgentSession).toHaveBeenCalledTimes(1));
    await executeAgentTool("call-second", params("second", selectedModel), undefined, undefined, mocks.ctx);

    const records = mocks.manager.listAgents();
    const second = records.find(record => record.display.description === "second")!;
    expect(second.lifecycle.status).toBe("queued");
    expect(second.execution.modelKey).toBe(selectedModel);

    mocks.allowedProviders = [];
    mocks.releaseFirst();
    await Promise.all(mocks.manager.listAgents().map(record => record.execution.promise));

    expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
    expect(second.lifecycle.status).toBe("error");
    expect(second.error).toContain("not authorized");
    // The locked model key is never swapped for the parent or a new assignment.
    expect(second.execution.modelKey).toBe(selectedModel);

    mocks.coordinator.dispose();
    await mocks.manager.dispose();
  });

  it("waits for a queued foreground agent until it actually settles", async () => {
    const selectedModel = "parent/worker-model";
    mocks.store.modelSelectionFor.mockReturnValue({ model: selectedModel, source: "automatic" });
    mocks.ctx.scopedModels[1] = { model: { provider: "parent", id: "worker-model" } };

    await executeAgentTool("call-background", params("first"), undefined, undefined, mocks.ctx);
    await vi.waitFor(() => expect(mocks.createAgentSession).toHaveBeenCalledTimes(1));

    let settled = false;
    const foreground = executeAgentTool(
      "call-foreground",
      { ...params("second"), run_in_background: false },
      undefined,
      undefined,
      mocks.ctx,
    ).then(result => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => expect(
      mocks.manager.listAgents().some(record => record.display.description === "second" && record.lifecycle.status === "queued"),
    ).toBe(true));
    expect(settled).toBe(false);

    mocks.releaseFirst();
    await foreground;
    expect(mocks.createAgentSession).toHaveBeenCalledTimes(2);

    mocks.coordinator.dispose();
    await mocks.manager.dispose();
  });
});
