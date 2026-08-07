import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state: any = {};
  state.reset = () => {
    state.firstPrompt = new Promise<void>((resolve) => { state.releaseFirst = resolve; });
    state.created = 0;
    state.fallbackResults = [];
    state.loaderOptions = [];
    state.sessions = [];
    state.entries = [];
    state.preloadCalls = [];
    state.skillMetaCalls = [];
    state.promptOutcomes = [];
    state.blockFirst = true;
    state.transientAttempts = 0;
    state.transientFailures = 0;
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
    const registeredTools = options.tools ?? ["read", "bash", "edit", "write", "grep", "find"];
    let activeTools = [...registeredTools];
    const session: any = {
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      agent: { onPayload: undefined },
      extensionRunner: { emit: vi.fn(async () => {}) },
      setSessionName: vi.fn(),
      bindExtensions: vi.fn(async () => {}),
      getAllTools: vi.fn(() => activeTools.map((name: string) => ({ name }))),
      getActiveToolNames: vi.fn(() => [...activeTools]),
      setActiveToolsByName: vi.fn((names: string[]) => { activeTools = [...names]; }),
      _isRetryableError: vi.fn(() => false),
      subscribe: vi.fn((callback: (event: any) => void) => {
        subscribers.push(callback);
        return () => {
          const subscriberIndex = subscribers.indexOf(callback);
          if (subscriberIndex >= 0) subscribers.splice(subscriberIndex, 1);
        };
      }),
      prompt: vi.fn(async () => {
        if (index === 0 && state.blockFirst) await state.firstPrompt;
        const transientMessage = {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "stream_read_error: response closed",
        };
        if (state.transientFailures > 0) {
          for (let attempt = 1; attempt <= state.transientFailures; attempt++) {
            state.transientAttempts++;
            if (attempt < state.transientFailures && session._isRetryableError(transientMessage)) continue;
            for (const subscriber of [...subscribers]) {
              subscriber({ type: "message_end", message: transientMessage });
            }
            return;
          }
        }
        const outcome = state.promptOutcomes.shift() ?? { text: "done" };
        const event = {
          type: "message_end",
          message: outcome.error
            ? { role: "assistant", content: [], stopReason: "error", errorMessage: outcome.error }
            : { role: "assistant", content: [{ type: "text", text: outcome.text }], stopReason: "stop" },
        };
        for (const subscriber of [...subscribers]) subscriber(event);
      }),
      steer: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    state.sessions.push(session);
    return { session, extensionsResult: {} };
  });
  return Object.assign(state, {
    coordinator: undefined as any,
    manager: undefined as any,
    ctx: undefined as any,
    pi: {
      exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })),
      appendEntry: vi.fn((customType: string, data: unknown) => {
        state.entries.push({ type: "custom", customType, data });
      }),
      sendMessage: vi.fn(),
    } as any,
  });
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: mocks.createAgentSession,
  DefaultResourceLoader: class {
    constructor(options: any) { mocks.loaderOptions.push(options); }
    async reload() {}
    getExtensions() { return { extensions: [] }; }
  },
  getAgentDir: () => "/tmp/pi-agent",
  loadProjectContextFiles: () => [],
  SessionManager: { inMemory: () => ({ appendCustomEntry: vi.fn() }) },
  SettingsManager: { create: () => ({}) },
}));

vi.mock("../../src/prompt/skill-loader.js", () => ({
  preloadSkills: vi.fn((names: string[]) => {
    mocks.preloadCalls.push([...names]);
    return [];
  }),
  loadSkillMeta: vi.fn((names: string[]) => {
    mocks.skillMetaCalls.push([...names]);
    return [];
  }),
}));

vi.mock("../../src/shell.js", () => ({
  getStore: () => mocks.store,
  getCoordinator: () => mocks.coordinator,
  getManager: () => mocks.manager,
  getNavigator: () => undefined,
  getPiInstance: () => mocks.pi,
  takeFallbackResults: (_sessionId?: string) => mocks.fallbackResults.splice(0),
  setFallbackResults: (_sessionId: string | undefined, results: any[]) => {
    mocks.fallbackResults.splice(0, mocks.fallbackResults.length, ...results);
  },
  getSessionCtx: () => mocks.ctx,
  withSubagentSpawn: (operation: () => Promise<unknown>) => operation(),
}));

import { AgentManager } from "../../src/agents/agent-manager.js";
import {
  registerAgents,
  setAgentScanDirs,
  setDefaultAgentsDisabled,
} from "../../src/agents/agent-types.js";
import type { AgentConfig } from "../../src/agents/types.js";
import { executeAgentTool } from "../../src/agents/tool-execution.js";
import { readResultEntries } from "../../src/spawn/result-inbox.js";
import { SpawnCoordinator } from "../../src/spawn/spawn-coordinator.js";

function params(description: string, model?: string, background = true, agent = "general-purpose") {
  return {
    agent,
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
    setAgentScanDirs("/tmp/no-user-agents", "/tmp/no-project-agents", false);
    registerAgents(new Map());
    mocks.routing = {
      enabled: true,
      enabledProviders: ["other"],
      agentAccess: { "general-purpose": { providers: { other: {} } } },
    };
    mocks.store.agent.defaultThinking = undefined;
    mocks.store.agent.loadSkillsImplicitly = true;
    mocks.store.agent.loadExtensionsImplicitly = true;
    mocks.store.agent.includeContextFiles = false;
    mocks.store.agent.systemPromptMode = "replace";
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
      sessionManager: {
        getBranch: () => [{ id: "origin-a" }],
        getEntries: () => mocks.entries,
        getLeafId: () => "origin-a",
        getSessionId: () => "test-session",
      },
      isIdle: () => true,
      getSystemPrompt: () => "Parent prompt",
      ui: { notify: vi.fn() },
    };
    mocks.manager = new AgentManager(undefined, { default: 1 });
    mocks.coordinator = new SpawnCoordinator(mocks.manager);
    mocks.manager.setOnComplete((record: any) => mocks.coordinator.onAgentComplete(record));
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

  it("keeps a queued Explore read-only after default agents are disabled", async () => {
    mocks.routing = { enabled: false, enabledProviders: [], agentAccess: {} };
    await executeAgentTool("first", params("blocker"), undefined, undefined, mocks.ctx);
    await vi.waitFor(() => expect(mocks.createAgentSession).toHaveBeenCalledTimes(1));
    await executeAgentTool("second", params("queued Explore", undefined, true, "Explore"), undefined, undefined, mocks.ctx);

    const queued = mocks.manager.listAgents().find((record: any) => record.display.description === "queued Explore")!;
    expect(queued.lifecycle.status).toBe("queued");

    setDefaultAgentsDisabled(true);
    mocks.store.agent.loadSkillsImplicitly = false;
    mocks.store.agent.loadExtensionsImplicitly = false;
    mocks.releaseFirst();
    await Promise.all(mocks.manager.listAgents().map((record: any) => record.execution.promise));

    const queuedOptions = mocks.createAgentSession.mock.calls[1][0];
    const queuedLoader = mocks.loaderOptions[1];
    const queuedSession = mocks.sessions[1];
    expect(queuedOptions.tools).toEqual(["read", "bash", "grep", "find"]);
    expect(queuedSession.getActiveToolNames()).toEqual(["read", "bash", "grep", "find"]);
    expect(queuedSession.getActiveToolNames()).not.toEqual(expect.arrayContaining(["edit", "write"]));
    expect(queuedLoader.noExtensions).toBe(false);
    expect(queuedLoader.noSkills).toBe(false);
    expect(queuedLoader.systemPromptOverride()).toContain("CRITICAL: READ-ONLY MODE");
    expect(queued.display.type).toBe("Explore");
    expect(queued.lifecycle.status, queued.error).toBe("completed");
    expect(mocks.ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("fallback"), expect.anything());

    const future = await executeAgentTool(
      "future",
      params("future Explore", undefined, true, "Explore"),
      undefined,
      undefined,
      mocks.ctx,
    );
    expect(future.isError).toBe(true);
    expect(mocks.createAgentSession).toHaveBeenCalledTimes(2);
    await dispose();
  });

  it("deep-copies a queued custom policy while future calls use its replacement", async () => {
    const config: AgentConfig = {
      name: "custom",
      description: "Custom agent",
      systemPrompt: "Original accepted prompt.",
      registeredTools: ["read"],
      tools: ["read"],
      extensions: ["original-extension"],
      skills: ["original-skill"],
      preloadSkills: ["original-preload"],
    };
    registerAgents(new Map([[config.name, config]]));
    mocks.routing = { enabled: false, enabledProviders: [], agentAccess: {} };

    await executeAgentTool("first", params("blocker"), undefined, undefined, mocks.ctx);
    await vi.waitFor(() => expect(mocks.createAgentSession).toHaveBeenCalledTimes(1));
    await executeAgentTool("second", params("queued custom", undefined, true, "custom"), undefined, undefined, mocks.ctx);

    (config.registeredTools as string[]).push("write");
    (config.tools as string[]).push("write");
    (config.extensions as string[]).push("mutated-extension");
    (config.skills as string[]).push("mutated-skill");
    (config.preloadSkills as string[]).push("mutated-preload");
    config.systemPrompt = "Mutated prompt.";

    const replacement: AgentConfig = {
      name: "custom",
      description: "Replacement agent",
      systemPrompt: "Replacement prompt.",
      registeredTools: ["write"],
      tools: ["write"],
      extensions: ["replacement-extension"],
      skills: ["replacement-skill"],
      preloadSkills: ["replacement-preload"],
    };
    registerAgents(new Map([[replacement.name, replacement]]));
    mocks.releaseFirst();
    await Promise.all(mocks.manager.listAgents().map((record: any) => record.execution.promise));

    const queuedOptions = mocks.createAgentSession.mock.calls[1][0];
    const queuedLoader = mocks.loaderOptions[1];
    expect(queuedOptions.tools).toEqual(["read"]);
    expect(mocks.sessions[1].getActiveToolNames()).toEqual(["read"]);
    expect(queuedLoader.systemPromptOverride()).toContain("Original accepted prompt.");
    expect(queuedLoader.systemPromptOverride()).not.toContain("Mutated prompt.");
    expect(mocks.preloadCalls[0]).toEqual(["original-preload"]);
    expect(mocks.skillMetaCalls[0]).toEqual(["original-skill"]);
    const filtered = queuedLoader.extensionsOverride({
      extensions: [
        { path: "/tmp/extensions/original-extension/index.ts" },
        { path: "/tmp/extensions/mutated-extension/index.ts" },
      ],
    });
    expect(filtered.extensions.map((extension: any) => extension.path)).toEqual([
      "/tmp/extensions/original-extension/index.ts",
    ]);

    await executeAgentTool("future", params("future custom", undefined, true, "custom"), undefined, undefined, mocks.ctx);
    const future = mocks.manager.listAgents().find((record: any) => record.display.description === "future custom")!;
    await future.execution.promise;

    expect(mocks.createAgentSession.mock.calls[2][0].tools).toEqual(["write"]);
    expect(mocks.sessions[2].getActiveToolNames()).toEqual(["write"]);
    expect(mocks.loaderOptions[2].systemPromptOverride()).toContain("Replacement prompt.");
    expect(mocks.preloadCalls[1]).toEqual(["replacement-preload"]);
    expect(mocks.skillMetaCalls[1]).toEqual(["replacement-skill"]);
    await dispose();
  });

  it("delivers a setup-complete provider error immediately and only once", async () => {
    await dispose();
    vi.useFakeTimers();
    mocks.manager = new AgentManager(undefined, { default: 1 });
    mocks.coordinator = new SpawnCoordinator(mocks.manager);
    mocks.manager.setOnComplete((record: any) => mocks.coordinator.onAgentComplete(record));
    mocks.routing = { enabled: false, enabledProviders: [], agentAccess: {} };
    mocks.blockFirst = false;
    mocks.promptOutcomes = [{ error: "quota exhausted" }];

    try {
      await executeAgentTool("error", params("provider error"), undefined, undefined, mocks.ctx);
      const record = mocks.manager.listAgents()[0];
      await record.execution.promise;

      expect(record).toMatchObject({
        lifecycle: { status: "error", resultPersisted: true },
        execution: { settled: true },
        error: "quota exhausted",
      });
      expect(readResultEntries(mocks.ctx).pending.size).toBe(1);
      expect(mocks.pi.sendMessage).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(31 * 60_000);

      expect(mocks.manager.getRecord(record.id)).toBeUndefined();
      expect(readResultEntries(mocks.ctx).pending.size).toBe(1);
      expect(mocks.entries.filter((entry: any) => entry.customType === "subagents-lite:pending-result")).toHaveLength(1);
      expect(mocks.pi.sendMessage).toHaveBeenCalledOnce();
      expect(mocks.createAgentSession).toHaveBeenCalledOnce();
    } finally {
      await dispose();
      vi.useRealTimers();
    }
  });

  it("delivers one terminal error after Pi exhausts transient retries", async () => {
    mocks.routing = { enabled: false, enabledProviders: [], agentAccess: {} };
    mocks.blockFirst = false;
    mocks.transientFailures = 3;

    await executeAgentTool("retry", params("retry exhaustion"), undefined, undefined, mocks.ctx);
    const record = mocks.manager.listAgents()[0];
    await record.execution.promise;

    expect(mocks.transientAttempts).toBe(3);
    expect(record.lifecycle.status).toBe("error");
    expect(record.error).toBe("stream_read_error: response closed");
    expect(mocks.createAgentSession).toHaveBeenCalledOnce();
    expect(mocks.entries.filter((entry: any) => entry.customType === "subagents-lite:pending-result")).toHaveLength(1);
    expect(readResultEntries(mocks.ctx).pending.size).toBe(1);
    expect(mocks.pi.sendMessage).toHaveBeenCalledOnce();
    await dispose();
  });

  it("continues a delivered Error without replacing its first delivery", async () => {
    mocks.routing = { enabled: false, enabledProviders: [], agentAccess: {} };
    mocks.blockFirst = false;
    mocks.promptOutcomes = [
      { error: "content_filter" },
      { text: "continued result" },
    ];

    await executeAgentTool("error", params("continuable error"), undefined, undefined, mocks.ctx);
    const record = mocks.manager.listAgents()[0];
    await record.execution.promise;
    const firstDeliveryId = record.execution.resultDeliveryId;

    expect(record.lifecycle.status).toBe("error");
    expect(readResultEntries(mocks.ctx).pending.get(firstDeliveryId)?.error).toBe("content_filter");
    await expect(mocks.coordinator.interact(record.id, "continue")).resolves.toEqual({ accepted: true });
    await record.execution.promise;
    const secondDeliveryId = record.execution.resultDeliveryId;

    expect(secondDeliveryId).not.toBe(firstDeliveryId);
    expect(record.lifecycle.status).toBe("completed");
    expect(readResultEntries(mocks.ctx).pending.size).toBe(2);
    expect(mocks.entries.filter((entry: any) =>
      entry.customType === "subagents-lite:pending-result"
      && entry.data.deliveryId === firstDeliveryId,
    )).toHaveLength(1);

    mocks.coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "stop" }]);
    mocks.coordinator.onParentSettled();
    await Promise.resolve();

    const firstAck = mocks.entries.find((entry: any) =>
      entry.customType === "subagents-lite:result-ack"
      && entry.data.deliveryIds.includes(firstDeliveryId),
    );
    expect(firstAck.data.deliveryIds).not.toContain(secondDeliveryId);
    expect(readResultEntries(mocks.ctx).pending.has(secondDeliveryId)).toBe(true);
    expect(mocks.pi.sendMessage).toHaveBeenCalledTimes(2);

    mocks.coordinator.onParentAgentEnd([{ role: "assistant", stopReason: "stop" }]);
    mocks.coordinator.onParentSettled();
    expect(readResultEntries(mocks.ctx).pending.size).toBe(0);
    const acknowledgedIds = mocks.entries
      .filter((entry: any) => entry.customType === "subagents-lite:result-ack")
      .flatMap((entry: any) => entry.data.deliveryIds);
    expect(acknowledgedIds.filter((id: string) => id === firstDeliveryId)).toHaveLength(1);
    expect(acknowledgedIds.filter((id: string) => id === secondDeliveryId)).toHaveLength(1);
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
