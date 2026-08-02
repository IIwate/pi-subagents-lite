import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state: any = {};
  state.reset = () => {
    state.firstPrompt = new Promise<void>((resolve) => { state.releaseFirst = resolve; });
    state.created = 0;
  };
  state.reset();
  state.routing = {
    enabled: true,
    enabledProviders: ["other"],
    agentAccess: { "general-purpose": { providers: { other: {} } } },
  };
  state.store = {
    agent: {
      defaultThinking: undefined,
      graceTurns: 2,
      forceBackground: false,
      loadSkillsImplicitly: true,
      loadExtensionsImplicitly: true,
      includeContextFiles: false,
      systemPromptMode: "replace",
    },
    get routing() { return structuredClone(state.routing); },
  };
  state.createAgentSession = vi.fn(async (options: any) => {
    const index = state.created++;
    const subscribers: Array<(event: any) => void> = [];
    const session = {
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      agent: { onPayload: undefined },
      setSessionName: vi.fn(),
      bindExtensions: vi.fn(async () => {}),
      getAllTools: vi.fn(() => []),
      setActiveToolsByName: vi.fn(),
      subscribe: vi.fn((callback: (event: any) => void) => {
        subscribers.push(callback);
        return () => {};
      }),
      prompt: vi.fn(async () => {
        if (index === 0) await state.firstPrompt;
        const event = {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
        };
        for (const subscriber of subscribers) subscriber(event);
      }),
      steer: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    return { session, extensionsResult: {} };
  });
  return Object.assign(state, {
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
  SessionManager: { inMemory: () => ({ appendCustomEntry: vi.fn() }) },
  SettingsManager: { create: () => ({}) },
}));

vi.mock("../../src/agents/agent-types.js", () => {
  const config = {
    name: "general-purpose",
    displayName: "Agent",
    description: "Test agent",
    systemPrompt: "Complete the task.",
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

function params(description: string, model?: string, background = true) {
  return {
    agent: "general-purpose",
    prompt: description,
    description,
    run_in_background: background,
    ...(model ? { model } : {}),
  };
}

async function dispose(): Promise<void> {
  mocks.coordinator.dispose();
  await mocks.manager.dispose();
}

describe("queued invocation snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
    mocks.routing = {
      enabled: true,
      enabledProviders: ["other"],
      agentAccess: { "general-purpose": { providers: { other: {} } } },
    };
    mocks.store.agent.defaultThinking = undefined;
    const models = [
      { provider: "parent", id: "main-model" },
      { provider: "parent", id: "next-model" },
      { provider: "other", id: "worker-model" },
    ];
    mocks.ctx = {
      cwd: "/tmp/project",
      model: models[0],
      modelRegistry: {
        find: vi.fn((provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id)),
        getAll: vi.fn(() => models),
        getAvailable: vi.fn(() => models),
      },
      scopedModels: [
        { model: models[0] },
        { model: models[2], thinkingLevel: "high" },
      ],
      sessionManager: { getBranch: () => [] },
      getSystemPrompt: () => "Parent prompt",
      ui: { notify: vi.fn() },
    };
    mocks.manager = new AgentManager(undefined, { default: 1 });
    mocks.coordinator = new SpawnCoordinator(mocks.manager);
  });

  it("keeps queued model, scope, and thinking after policy and session edits", async () => {
    await executeAgentTool("first", params("first", "other/worker-model"), undefined, undefined, mocks.ctx);
    await vi.waitFor(() => expect(mocks.createAgentSession).toHaveBeenCalledTimes(1));
    await executeAgentTool("second", params("second", "other/worker-model"), undefined, undefined, mocks.ctx);

    const second = mocks.manager.listAgents().find((record: any) => record.display.description === "second")!;
    expect(second.lifecycle.status).toBe("queued");

    mocks.routing.enabled = false;
    mocks.routing.enabledProviders = [];
    mocks.routing.agentAccess = {};
    mocks.ctx.model = { provider: "parent", id: "next-model" };
    mocks.ctx.scopedModels = [{ model: mocks.ctx.model, thinkingLevel: "low" }];
    mocks.releaseFirst();
    await Promise.all(mocks.manager.listAgents().map((record: any) => record.execution.promise));

    expect(mocks.createAgentSession).toHaveBeenCalledTimes(2);
    const queuedOptions = mocks.createAgentSession.mock.calls[1][0];
    expect(queuedOptions.model).toEqual({ provider: "other", id: "worker-model" });
    expect(queuedOptions.scopedModels).toEqual([
      { model: { provider: "parent", id: "main-model" } },
      { model: { provider: "other", id: "worker-model" }, thinkingLevel: "high" },
    ]);
    expect(queuedOptions.thinkingLevel).toBe("high");
    expect(second.lifecycle.status, second.error).toBe("completed");

    const future = await executeAgentTool("future", params("future", "other/worker-model"), undefined, undefined, mocks.ctx);
    expect(future.isError).toBe(true);
    expect(mocks.createAgentSession).toHaveBeenCalledTimes(2);
    await dispose();
  });

  it("keeps an undefined thinking snapshot after the default changes", async () => {
    mocks.routing = { enabled: false, enabledProviders: [], agentAccess: {} };
    await executeAgentTool("first", params("first"), undefined, undefined, mocks.ctx);
    await vi.waitFor(() => expect(mocks.createAgentSession).toHaveBeenCalledTimes(1));
    await executeAgentTool("second", params("second"), undefined, undefined, mocks.ctx);

    mocks.store.agent.defaultThinking = "xhigh";
    mocks.releaseFirst();
    await Promise.all(mocks.manager.listAgents().map((record: any) => record.execution.promise));

    expect(mocks.createAgentSession.mock.calls[1][0].thinkingLevel).toBeUndefined();
    await dispose();
  });

  it("keeps the enqueue-time parent model when model is omitted", async () => {
    mocks.routing = { enabled: false, enabledProviders: [], agentAccess: {} };
    await executeAgentTool("first", params("first"), undefined, undefined, mocks.ctx);
    await vi.waitFor(() => expect(mocks.createAgentSession).toHaveBeenCalledTimes(1));
    await executeAgentTool("second", params("second"), undefined, undefined, mocks.ctx);

    mocks.ctx.model = { provider: "parent", id: "next-model" };
    mocks.releaseFirst();
    await Promise.all(mocks.manager.listAgents().map((record: any) => record.execution.promise));

    expect(mocks.createAgentSession.mock.calls[1][0].model).toEqual({ provider: "parent", id: "main-model" });
    await dispose();
  });

  it("waits for a queued foreground Agent until it settles", async () => {
    mocks.routing = { enabled: false, enabledProviders: [], agentAccess: {} };
    await executeAgentTool("first", params("first"), undefined, undefined, mocks.ctx);
    await vi.waitFor(() => expect(mocks.createAgentSession).toHaveBeenCalledTimes(1));

    let settled = false;
    const foreground = executeAgentTool("second", params("second", undefined, false), undefined, undefined, mocks.ctx)
      .then((result) => { settled = true; return result; });
    await vi.waitFor(() => expect(
      mocks.manager.listAgents().some((record: any) => record.display.description === "second" && record.lifecycle.status === "queued"),
    ).toBe(true));
    expect(settled).toBe(false);

    mocks.releaseFirst();
    await foreground;
    expect(settled).toBe(true);
    expect(mocks.createAgentSession).toHaveBeenCalledTimes(2);
    await dispose();
  });
});
