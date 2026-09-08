import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { createDefaultConfig, createTestHarness, type TestHarness } from "../harness.js";
import { makeResolvablePromise } from "../fixtures.js";

const mocks = vi.hoisted(() => ({
  agentDir: "",
  runtime: undefined as unknown as ModelRuntime,
  providers: [] as ReturnType<typeof fauxProvider>[],
  loaderOptions: [] as ConstructorParameters<typeof DefaultResourceLoader>[0][],
  sessions: [] as Awaited<ReturnType<typeof createAgentSession>>["session"][],
  entries: [] as any[],
  preloadCalls: [] as string[][],
  skillMetaCalls: [] as string[][],
  firstStarted: false,
  releaseFirst: () => {},
  store: undefined as unknown as import("../../src/config/config-store.js").ConfigStore,
  coordinator: undefined as unknown as import("../../src/spawn/spawn-coordinator.js").SpawnCoordinator,
  manager: undefined as unknown as import("../../src/agents/agent-manager.js").AgentManager,
  ctx: undefined as any,
  createAgentSession: vi.fn<typeof createAgentSession>(),
  pi: {
    exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      mocks.entries.push({ type: "custom", customType, data });
    }),
    sendMessage: vi.fn((message: any) => {
      mocks.entries.push({
        ...message, type: "custom_message", id: `msg-${mocks.entries.length}`,
        parentId: "origin-a", timestamp: new Date().toISOString(),
      });
    }),
  } as any,
}));

// Pi owns session execution and retries; only the model transport is supplied by the fixture.
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  mocks.createAgentSession.mockImplementation(async options => {
    const result = await actual.createAgentSession({ ...options, modelRuntime: mocks.runtime });
    mocks.sessions.push(result.session);
    return result;
  });
  return {
    ...actual,
    createAgentSession: mocks.createAgentSession,
    getAgentDir: () => mocks.agentDir,
    DefaultResourceLoader: class extends actual.DefaultResourceLoader {
      constructor(options: ConstructorParameters<typeof DefaultResourceLoader>[0]) {
        super(options);
        mocks.loaderOptions.push(options);
      }
    },
  };
});

vi.mock("../../src/prompt/skill-loader.js", () => ({
  preloadSkills: vi.fn((names: string[]) => { mocks.preloadCalls.push([...names]); return []; }),
  loadSkillMeta: vi.fn((names: string[]) => { mocks.skillMetaCalls.push([...names]); return []; }),
}));

vi.mock("../../src/shell.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/shell.js")>(),
  getStore: () => mocks.store,
  getCoordinator: () => mocks.coordinator,
  getManager: () => mocks.manager,
  getNavigator: () => undefined,
  getPiInstance: () => mocks.pi,
  getSessionCtx: () => mocks.ctx,
}));

vi.mock("../../src/spawn/result-inbox.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/spawn/result-inbox.js")>();
  return {
    ...actual,
    readDurableLogState: vi.fn(async (_file: string, sessionId: string) =>
      actual.deriveResultStateFromEntries(mocks.entries, sessionId)),
  };
});

import { AgentManager } from "../../src/agents/agent-manager.js";
import { registerAgents, setDefaultAgentsDisabled } from "../../src/agents/agent-types.js";
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
  await mocks.manager.dispose();
  await mocks.coordinator.reconcileDeliveryState();
  mocks.coordinator.dispose();
}

describe("queued invocation snapshots", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = createTestHarness({ initialConfig: createDefaultConfig({
      modelRouting: {
        enabled: true, enabledProviders: ["other"],
        agentAccess: { "general-purpose": { providers: { other: {} } } },
      },
      agent: { forceBackground: false, graceTurns: 2, includeContextFiles: false },
    }) });
    vi.clearAllMocks();
    const first = makeResolvablePromise();
    mocks.releaseFirst = () => first.resolve(undefined);
    mocks.store = harness.store;
    mocks.agentDir = harness.createTempDir();
    writeFileSync(join(mocks.agentDir, "settings.json"), JSON.stringify({
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 }, compaction: { enabled: false },
    }));
    mocks.loaderOptions = [];
    mocks.sessions = [];
    mocks.entries = [];
    mocks.preloadCalls = [];
    mocks.skillMetaCalls = [];
    mocks.firstStarted = false;
    mocks.runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
      modelsPath: null, refreshOnCreate: false,
    });
    mocks.providers = [
      fauxProvider({ provider: "parent", api: `parent-${harness.sessionId}`, tokensPerSecond: 100000,
        models: [{ id: "main-model", reasoning: true }, { id: "next-model", reasoning: true }] }),
      fauxProvider({ provider: "other", api: `other-${harness.sessionId}`, tokensPerSecond: 100000,
        models: [{ id: "worker-model", reasoning: true }] }),
    ];
    for (const provider of mocks.providers) {
      mocks.runtime.registerNativeProvider(provider.provider);
      provider.setResponses([
        async (_context, options) => {
          if (!mocks.firstStarted) {
            mocks.firstStarted = true;
            await Promise.race([first.promise, new Promise<void>(resolve => {
              if (options?.signal?.aborted) resolve();
              else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            })]);
          }
          return fauxAssistantMessage("done");
        },
        fauxAssistantMessage("done"),
        fauxAssistantMessage("done"),
      ]);
    }
    const models = mocks.providers.flatMap(provider => provider.models);
    mocks.ctx = {
      cwd: mocks.agentDir,
      model: { ...models[0] },
      modelRegistry: {
        find: vi.fn((provider: string, id: string) => models.find(model => model.provider === provider && model.id === id)),
        getAll: vi.fn(() => models), getAvailable: vi.fn(() => models),
      },
      scopedModels: [{ model: models[0] }, { model: models[2], thinkingLevel: "high" }],
      sessionManager: {
        getBranch: () => [{ id: "origin-a" }], getEntries: () => mocks.entries,
        getLeafId: () => "origin-a", getSessionId: () => harness.sessionId,
        getSessionFile: () => `${harness.sessionId}.jsonl`,
      },
      isIdle: () => true, getSystemPrompt: () => "Parent prompt", ui: { notify: vi.fn() },
    };
    mocks.manager = new AgentManager(undefined, { default: 1 });
    mocks.coordinator = new SpawnCoordinator(mocks.manager);
    mocks.manager.setOnComplete(record => mocks.coordinator.onAgentComplete(record));
    harness.onDispose(async () => {
      mocks.releaseFirst();
      await dispose();
      for (const options of mocks.createAgentSession.mock.calls) await options[0]?.settingsManager?.flush();
    });
  });

  afterEach(async () => { await harness.dispose(); });

  it("keeps queued model, scope, and thinking after policy and session edits", async () => {
    await executeAgentTool("first", params("first", "other/worker-model"), undefined, undefined, mocks.ctx);
    await vi.waitFor(() => expect(mocks.createAgentSession).toHaveBeenCalledTimes(1));
    await executeAgentTool("second", params("second", "other/worker-model"), undefined, undefined, mocks.ctx);

    const second = mocks.manager.listAgents().find((record: any) => record.display.description === "second")!;
    expect(second.lifecycle.status).toBe("queued");

    mocks.store.mutate.routing.clearAll();
    mocks.ctx.model = { provider: "parent", id: "next-model" };
    mocks.ctx.scopedModels = [{ model: mocks.ctx.model, thinkingLevel: "low" }];
    mocks.releaseFirst();
    await Promise.all(mocks.manager.listAgents().map((record: any) => record.execution.promise));

    expect(mocks.createAgentSession).toHaveBeenCalledTimes(2);
    const queuedOptions = mocks.createAgentSession.mock.calls[1][0]!;
    expect(queuedOptions.model).toMatchObject({ provider: "other", id: "worker-model", reasoning: true });
    expect(queuedOptions.scopedModels).toMatchObject([
      { model: { provider: "parent", id: "main-model", reasoning: true } },
      { model: { provider: "other", id: "worker-model", reasoning: true }, thinkingLevel: "high" },
    ]);
    expect(queuedOptions.thinkingLevel).toBe("high");
    expect(second.lifecycle.status, second.error).toBe("completed");

    await expect(executeAgentTool("future", params("future", "other/worker-model"), undefined, undefined, mocks.ctx))
      .rejects.toThrow("Model routing is OFF");
    expect(mocks.createAgentSession).toHaveBeenCalledTimes(2);
    await dispose();
  });

  it("keeps a queued Explore read-only after default agents are disabled", async () => {
    mocks.store.mutate.routing.clearAll();
    await executeAgentTool("first", params("blocker"), undefined, undefined, mocks.ctx);
    await vi.waitFor(() => expect(mocks.createAgentSession).toHaveBeenCalledTimes(1));
    await executeAgentTool("second", params("queued Explore", undefined, true, "Explore"), undefined, undefined, mocks.ctx);

    const queued = mocks.manager.listAgents().find((record: any) => record.display.description === "queued Explore")!;
    expect(queued.lifecycle.status).toBe("queued");

    setDefaultAgentsDisabled(true);
    mocks.store.mutate.agent.setLoadSkillsImplicitly(false);
    mocks.store.mutate.agent.setLoadExtensionsImplicitly(false);
    mocks.releaseFirst();
    await Promise.all(mocks.manager.listAgents().map((record: any) => record.execution.promise));

    const queuedOptions = mocks.createAgentSession.mock.calls[1][0]!;
    const queuedLoader = mocks.loaderOptions[1];
    const queuedSession = mocks.sessions[1];
    const expectedReadOnlyTools = process.platform === "win32"
      ? ["read", "bash", "powershell", "grep", "find"]
      : ["read", "bash", "grep", "find"];
    expect(queuedOptions.tools).toEqual(expectedReadOnlyTools);
    expect(queuedSession.getActiveToolNames()).toEqual(expectedReadOnlyTools);
    expect(queuedSession.getActiveToolNames()).not.toEqual(expect.arrayContaining(["edit", "write"]));
    expect(queuedLoader.noExtensions).toBe(false);
    expect(queuedLoader.noSkills).toBe(false);
    expect(queuedLoader.systemPromptOverride!(undefined)).toContain("CRITICAL: READ-ONLY MODE");
    expect(queued.display.type).toBe("Explore");
    expect(queued.lifecycle.status, queued.error).toBe("completed");
    expect(mocks.ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("fallback"), expect.anything());

    const future = executeAgentTool(
      "future",
      params("future Explore", undefined, true, "Explore"),
      undefined,
      undefined,
      mocks.ctx,
    );
    await expect(future).rejects.toThrow("Unknown agent type: Explore");
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
    mocks.store.mutate.routing.clearAll();

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

    const queuedOptions = mocks.createAgentSession.mock.calls[1][0]!;
    const queuedLoader = mocks.loaderOptions[1];
    expect(queuedOptions.tools).toEqual(["read"]);
    expect(mocks.sessions[1].getActiveToolNames()).toEqual(["read"]);
    expect(queuedLoader.systemPromptOverride!(undefined)).toContain("Original accepted prompt.");
    expect(queuedLoader.systemPromptOverride!(undefined)).not.toContain("Mutated prompt.");
    expect(mocks.preloadCalls[0]).toEqual(["original-preload"]);
    expect(mocks.skillMetaCalls[0]).toEqual(["original-skill"]);
    const filtered = queuedLoader.extensionsOverride!({
      extensions: [
        { path: "/tmp/extensions/original-extension/index.ts" },
        { path: "/tmp/extensions/mutated-extension/index.ts" },
      ],
    } as Parameters<NonNullable<typeof queuedLoader.extensionsOverride>>[0]);
    expect(filtered.extensions.map((extension: any) => extension.path)).toEqual([
      "/tmp/extensions/original-extension/index.ts",
    ]);

    await executeAgentTool("future", params("future custom", undefined, true, "custom"), undefined, undefined, mocks.ctx);
    const future = mocks.manager.listAgents().find((record: any) => record.display.description === "future custom")!;
    await future.execution.promise;

    expect(mocks.createAgentSession.mock.calls[2][0]!.tools).toEqual(["write"]);
    expect(mocks.sessions[2].getActiveToolNames()).toEqual(["write"]);
    expect(mocks.loaderOptions[2].systemPromptOverride!(undefined)).toContain("Replacement prompt.");
    expect(mocks.preloadCalls[1]).toEqual(["replacement-preload"]);
    expect(mocks.skillMetaCalls[1]).toEqual(["replacement-skill"]);
    await dispose();
  });

  it("delivers a setup-complete provider error immediately and only once", async () => {
    await dispose();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.manager = new AgentManager(undefined, { default: 1 });
    mocks.coordinator = new SpawnCoordinator(mocks.manager);
    mocks.manager.setOnComplete((record: any) => mocks.coordinator.onAgentComplete(record));
    mocks.store.mutate.routing.clearAll();
    mocks.providers[0].setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "quota exhausted" })]);

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
    mocks.store.mutate.routing.clearAll();
    mocks.providers[0].setResponses(Array.from({ length: 3 }, () =>
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "stream_read_error: response closed" })));

    await executeAgentTool("retry", params("retry exhaustion"), undefined, undefined, mocks.ctx);
    const record = mocks.manager.listAgents()[0];
    await record.execution.promise;

    expect(mocks.providers[0].state.callCount).toBe(3);
    expect(record.lifecycle.status).toBe("error");
    expect(record.error).toBe("stream_read_error: response closed");
    expect(mocks.createAgentSession).toHaveBeenCalledOnce();
    expect(mocks.entries.filter((entry: any) => entry.customType === "subagents-lite:pending-result")).toHaveLength(1);
    expect(readResultEntries(mocks.ctx).pending.size).toBe(1);
    expect(mocks.pi.sendMessage).toHaveBeenCalledOnce();
    await dispose();
  });

  it("continues a delivered Error without replacing its first delivery", async () => {
    mocks.store.mutate.routing.clearAll();
    mocks.providers[0].setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "content_filter" }),
      fauxAssistantMessage("continued result"),
    ]);

    await executeAgentTool("error", params("continuable error"), undefined, undefined, mocks.ctx);
    const record = mocks.manager.listAgents()[0];
    await record.execution.promise;
    const firstDeliveryId = record.execution.resultDeliveryId;

    expect(record.lifecycle.status).toBe("error");
    expect(readResultEntries(mocks.ctx).pending.get(firstDeliveryId!)?.error).toBe("content_filter");
    await expect(mocks.coordinator.interact(record.id, "continue")).resolves.toEqual({ accepted: true });
    await record.execution.promise;
    const delivered = mocks.coordinator.deliverSelectedMessages(record.id, [0]);
    expect(delivered).toBeDefined();
    const secondDeliveryId = delivered!.deliveryId;

    expect(secondDeliveryId).not.toBe(firstDeliveryId);
    expect(record.lifecycle.status).toBe("completed");
    expect(readResultEntries(mocks.ctx).pending.size).toBe(2);
    expect(mocks.entries.filter((entry: any) =>
      entry.customType === "subagents-lite:pending-result"
      && entry.data.deliveryId === firstDeliveryId,
    )).toHaveLength(1);

    mocks.coordinator.onParentAgentEnd();
    await mocks.coordinator.onParentSettled();
    await Promise.resolve();

    const firstAck = mocks.entries.find((entry: any) =>
      entry.customType === "subagents-lite:result-ack"
      && entry.data.deliveryIds.includes(firstDeliveryId),
    );
    expect(firstAck.data.deliveryIds).not.toContain(secondDeliveryId);
    expect(readResultEntries(mocks.ctx).pending.has(secondDeliveryId)).toBe(true);
    expect(mocks.pi.sendMessage).toHaveBeenCalledTimes(2);

    mocks.coordinator.onParentAgentEnd();
    await mocks.coordinator.onParentSettled();
    expect(readResultEntries(mocks.ctx).pending.size).toBe(0);
    const acknowledgedIds = mocks.entries
      .filter((entry: any) => entry.customType === "subagents-lite:result-ack")
      .flatMap((entry: any) => entry.data.deliveryIds);
    expect(acknowledgedIds.filter((id: string) => id === firstDeliveryId)).toHaveLength(1);
    expect(acknowledgedIds.filter((id: string) => id === secondDeliveryId)).toHaveLength(1);
    await dispose();
  });

  it.each([
    { source: "inherited", thinking: undefined, expected: "high" },
    { source: "explicit", thinking: "low", expected: "low" },
  ])("keeps $source thinking when the parent changes before dequeue", async ({ thinking, expected }) => {
    mocks.ctx.scopedModels = [];
    mocks.ctx.thinkingLevel = "high";
    await executeAgentTool("first", params("blocker", "other/worker-model"), undefined, undefined, mocks.ctx);
    await vi.waitFor(() => expect(mocks.createAgentSession).toHaveBeenCalledTimes(1));
    await executeAgentTool(
      "second",
      { ...params("queued", "other/worker-model"), thinking },
      undefined,
      undefined,
      mocks.ctx,
    );

    const queued = mocks.manager.listAgents().find((record: any) => record.display.description === "queued")!;
    expect(queued.lifecycle.status).toBe("queued");
    expect(queued.display.invocation!.thinkingLevel).toBe(expected);

    mocks.ctx.thinkingLevel = "off";
    mocks.releaseFirst();
    await Promise.all(mocks.manager.listAgents().map((record: any) => record.execution.promise));

    expect(mocks.createAgentSession.mock.calls[1][0]!.thinkingLevel).toBe(expected);
    expect(queued.display.invocation!.thinkingLevel).toBe(expected);
    expect(queued.lifecycle.status, queued.error).toBe("completed");
    await dispose();
  });

  it("keeps a clamped undefined snapshot after parent and default changes", async () => {
    mocks.store.mutate.routing.clearAll();
    mocks.ctx.model.reasoning = false;
    mocks.ctx.thinkingLevel = "high";
    await executeAgentTool("first", params("first"), undefined, undefined, mocks.ctx);
    await vi.waitFor(() => expect(mocks.createAgentSession).toHaveBeenCalledTimes(1));
    await executeAgentTool("second", params("second"), undefined, undefined, mocks.ctx);

    const queued = mocks.manager.listAgents().find((record: any) => record.display.description === "second")!;
    expect(queued.lifecycle.status).toBe("queued");
    expect(queued.display.invocation!.thinkingLevel).toBeUndefined();

    mocks.ctx.thinkingLevel = "low";
    mocks.ctx.model.reasoning = true;
    mocks.store.mutate.agent.setDefaultThinking("xhigh");
    mocks.releaseFirst();
    await Promise.all(mocks.manager.listAgents().map((record: any) => record.execution.promise));

    expect(mocks.createAgentSession.mock.calls[1][0]!.thinkingLevel).toBeUndefined();
    expect(queued.execution.session!.thinkingLevel).toBe("off");
    expect(queued.display.invocation!.thinkingLevel).toBeUndefined();
    expect(queued.lifecycle.status, queued.error).toBe("completed");
    await dispose();
  });

  it("keeps the enqueue-time parent model when model is omitted", async () => {
    mocks.store.mutate.routing.clearAll();
    await executeAgentTool("first", params("first"), undefined, undefined, mocks.ctx);
    await vi.waitFor(() => expect(mocks.createAgentSession).toHaveBeenCalledTimes(1));
    await executeAgentTool("second", params("second"), undefined, undefined, mocks.ctx);

    mocks.ctx.model = { provider: "parent", id: "next-model" };
    mocks.releaseFirst();
    await Promise.all(mocks.manager.listAgents().map((record: any) => record.execution.promise));

    expect(mocks.createAgentSession.mock.calls[1][0]!.model).toMatchObject({ provider: "parent", id: "main-model", reasoning: true });
    await dispose();
  });

  it("waits for a queued foreground Agent until it settles", async () => {
    mocks.store.mutate.routing.clearAll();
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
