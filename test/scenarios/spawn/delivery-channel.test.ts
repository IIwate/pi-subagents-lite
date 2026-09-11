import { mkdirSync, readFileSync, renameSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore, type Context as ProviderContext } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI, type ExtensionContext, type ExtensionError, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { HarnessDriver } from "../../../src/drivers/harness-driver.js";
import { PiDeliveryChannel, RESULT_MESSAGE_TYPE } from "../../../src/drivers/pi-delivery-channel.js";
import { TaskEngine } from "../../../src/engine/task-engine.js";
import type { DeliveryChannel, TaskBinding, TaskDelivery } from "../../../src/engine/contracts.js";
import { createTestHarness, type TestHarness } from "../../support/harness.js";

const context = BACKGROUND_CONTEXT;

describe("Native task delivery to an official Pi parent", () => {
  let resources: TestHarness;
  let directory: string;

  beforeEach(() => { resources = createTestHarness(); directory = resources.createTempDir("pi-parent-channel-"); });
  afterEach(() => resources.dispose());

  async function host(register?: ExtensionFactory) {
    const provider = fauxProvider({ provider: "parent", api: "parent", tokensPerSecond: 100000, models: [{ id: "main" }] });
    const worker = fauxProvider({ provider: "worker", api: "worker", tokensPerSecond: 100000, models: [{ id: "child", reasoning: true }] });
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
      modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(provider.provider);
    runtime.registerNativeProvider(worker.provider);
    let api!: ExtensionAPI;
    let ctx!: ExtensionContext;
    const errors: ExtensionError[] = [];
    const loader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        api = pi;
        pi.on("session_start", (_event, current) => { ctx = current; });
        return register?.(pi);
      }],
    });
    await loader.reload();
    const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const { session } = await createAgentSession({
      cwd: directory, agentDir: directory, modelRuntime: runtime, model: provider.getModel(),
      sessionManager: SessionManager.create(directory, directory), settingsManager: settings, resourceLoader: loader,
    });
    resources.onDispose(async () => { await session.abort(); session.dispose(); await settings.flush(); });
    await session.bindExtensions({ onError: error => { errors.push(error); } });
    provider.setResponses([fauxAssistantMessage("Parent ready")]);
    await session.prompt("Root context");
    const root = session.sessionManager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user")!.id;
    const origin = session.sessionManager.getLeafId()!;
    return { session, provider, worker, runtime, api, ctx, errors, root, origin,
      channel: new PiDeliveryChannel(api, () => ctx) };
  }

  type Host = Awaited<ReturnType<typeof host>>;

  async function child(parent: Host, taskId = "child-task") {
    const env = new NodeExecutionEnv({ cwd: directory });
    const repository = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(directory, taskId) });
    resources.onDispose(() => env.cleanup(context));
    resources.onDispose(() => repository.close(context));
    const session = await repository.create({ cwd: directory, parentSessionId: parent.ctx.sessionManager.getSessionId() }, context);
    const binding: TaskBinding = {
      taskId, mode: "background", control: "autonomous", parent: { sessionId: parent.ctx.sessionManager.getSessionId(), entryId: parent.origin },
      policy: { agent: "worker", model: { provider: "worker", id: "child" }, thinkingLevel: "low", tools: [],
        cwd: directory, systemPrompt: "Child context only", limits: { graceTurns: 1 } },
    };
    const open = async (restore = false) => {
      const driver = await HarnessDriver.open({ session: restore ? await repository.open(session.metadata, context) : session,
        models: parent.runtime, binding: restore ? undefined : binding, retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
        compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1000 } });
      resources.onDispose(() => driver.close());
      return driver;
    };
    return { driver: await open(), open };
  }

  function engine(channel: DeliveryChannel) {
    const tasks = new TaskEngine({ default: 2 }, channel);
    resources.onDispose(() => tasks.close());
    return tasks;
  }

  function receipts(parent: Host) {
    return parent.session.sessionManager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === RESULT_MESSAGE_TYPE);
  }

  it("dispatches through the extension tool entry, waits for parent idle, and verifies receipt before the parent answers", async () => {
    let tasks!: TaskEngine;
    let worker!: HarnessDriver;
    const parentTool = Promise.withResolvers<void>();
    const releaseParent = Promise.withResolvers<void>();
    const parent = await host(pi => {
      pi.registerTool({ name: "native_child", label: "Native child", description: "Dispatch an isolated child.", parameters: Type.Object({}),
        execute: async () => {
          await tasks.accept(worker, { text: "Child work" });
          parentTool.resolve();
          await releaseParent.promise;
          return { content: [{ type: "text", text: "Child accepted" }], details: {} };
        },
      });
      pi.on("agent_settled", async () => { if (tasks) await tasks.flushDeliveries(); });
    });
    const native = await child(parent);
    worker = native.driver;
    tasks = engine(parent.channel);
    const childRequests: ProviderContext[] = [];
    const parentRequests: ProviderContext[] = [];
    parent.worker.setResponses([request => { childRequests.push(request); return fauxAssistantMessage("Durable child report"); }]);
    parent.provider.setResponses([
      fauxAssistantMessage(fauxToolCall("native_child", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Parent work finished"),
      request => { parentRequests.push(request); return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Parent response failed" }); },
    ]);
    resources.onDispose(() => { releaseParent.resolve(); });
    const run = parent.session.prompt("Delegate work");
    resources.onDispose(async () => { releaseParent.resolve(); await run; });
    await Promise.race([parentTool.promise, run.then(() => { throw new Error("Parent settled before dispatching the child tool"); })]);
    await tasks.wait("child-task");
    await tasks.flushDeliveries();
    expect(receipts(parent)).toHaveLength(0);
    expect((await worker.store.deliveries())[0].receipt).toBeUndefined();
    expect(childRequests[0].systemPrompt).toBe("Child context only");
    expect(JSON.stringify(childRequests[0].messages)).not.toContain("native_child");
    releaseParent.resolve();
    await run;
    await parent.session.waitForIdle();
    await tasks.flushDeliveries();
    expect(receipts(parent)).toHaveLength(1);
    expect(JSON.stringify(parentRequests[0].messages)).toContain("Durable child report");
    expect((await worker.store.deliveries())[0].receipt?.entryId).toBe(receipts(parent)[0].id);
    expect(readFileSync(parent.session.sessionManager.getSessionFile()!, "utf8")).toContain("Durable child report");
    expect(parent.errors).toEqual([]);
  });

  it.each(["response", "acknowledgement"])("recovers a lost %s after parent persistence without another result or wake", async loss => {
    const parent = await host();
    const native = await child(parent);
    const attempted = Promise.withResolvers<void>();
    let lose = true;
    const channel: DeliveryChannel = { deliver: async (delivery, eligible) => {
      const result = await parent.channel.deliver(delivery, eligible);
      if (loss === "response" && lose && result.status === "received") {
        lose = false; attempted.resolve(); throw new Error("Delivery response lost");
      }
      return result;
    } };
    if (loss === "acknowledgement") {
      vi.spyOn(native.driver.store, "acknowledge").mockImplementationOnce(async () => { attempted.resolve(); throw new Error("Child acknowledgement write failed"); });
    }
    parent.worker.setResponses([fauxAssistantMessage("One result")]);
    parent.provider.setResponses([fauxAssistantMessage("Receipt consumed")]);
    const tasks = engine(channel);
    await tasks.accept(native.driver, { text: "Run once" });
    await attempted.promise;
    await parent.session.waitForIdle();
    await tasks.close();
    expect(receipts(parent)).toHaveLength(1);
    const parentCalls = parent.provider.state.callCount;

    const restored = await native.open(true);
    const recovered = engine(new PiDeliveryChannel(parent.api, () => parent.ctx));
    await recovered.restore(restored);
    await recovered.flushDeliveries();
    await recovered.flushDeliveries();
    expect(receipts(parent)).toHaveLength(1);
    expect(parent.provider.state.callCount).toBe(parentCalls);
    expect(parent.worker.state.callCount).toBe(1);
    expect((await restored.store.deliveries())[0].receipt?.entryId).toBe(receipts(parent)[0].id);
  });

  it("rechecks navigation and takeover after delayed outbox reads while retaining both results", async () => {
    const parentEntered = Promise.withResolvers<void>();
    const releaseParent = Promise.withResolvers<void>();
    const parent = await host(pi => {
      pi.registerTool({ name: "hold_parent", label: "Hold parent", description: "Hold the parent run.", parameters: Type.Object({}),
        execute: async () => { parentEntered.resolve(); await releaseParent.promise; return { content: [{ type: "text", text: "Done" }], details: {} }; },
      });
    });
    parent.provider.setResponses([
      fauxAssistantMessage(fauxToolCall("hold_parent", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Parent finished"),
      fauxAssistantMessage("Only the eligible result was consumed"),
    ]);
    parent.worker.setResponses([fauxAssistantMessage("Branch result"), fauxAssistantMessage("Manual result")]);
    const first = await child(parent, "branch-task");
    const second = await child(parent, "manual-task");
    const tasks = engine(parent.channel);
    resources.onDispose(() => { releaseParent.resolve(); });
    const run = parent.session.prompt("Hold this branch");
    resources.onDispose(async () => { releaseParent.resolve(); await run; });
    await Promise.race([parentEntered.promise, run.then(() => { throw new Error("Parent settled before entering its tool"); })]);
    await tasks.accept(first.driver, { text: "Branch work" });
    await tasks.accept(second.driver, { text: "Manual work" });
    await Promise.all([tasks.wait("branch-task"), tasks.wait("manual-task")]);
    await tasks.flushDeliveries();
    releaseParent.resolve();
    await run;

    const reading = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    const read = first.driver.store.deliveries.bind(first.driver.store);
    vi.spyOn(first.driver.store, "deliveries").mockImplementationOnce(async () => {
      const saved = await read(); reading.resolve(); await releaseRead.promise; return saved;
    });
    resources.onDispose(() => { releaseRead.resolve(); });
    const flush = tasks.flushDeliveries();
    await reading.promise;
    await parent.session.navigateTree(parent.root, { summarize: false });
    await tasks.takeOver("manual-task");
    releaseRead.resolve();
    await flush;
    expect(receipts(parent)).toHaveLength(0);
    expect((await first.driver.store.deliveries())[0].receipt).toBeUndefined();
    expect((await second.driver.store.deliveries())[0].receipt).toBeUndefined();

    await parent.session.navigateTree(parent.origin, { summarize: false });
    await tasks.flushDeliveries();
    await parent.session.waitForIdle();
    expect(receipts(parent)).toHaveLength(1);
    expect(receipts(parent)[0]).toMatchObject({ content: expect.stringContaining("Branch result") });
    expect((await second.driver.store.deliveries())[0].receipt).toBeUndefined();
  });

  it("preserves a failed parent append and refuses to duplicate a result left only in memory", async () => {
    const parent = await host();
    const delivery: TaskDelivery = {
      deliveryId: "failed-parent-write", taskId: "task", operationId: "operation", kind: "automatic", status: "completed",
      parent: { sessionId: parent.ctx.sessionManager.getSessionId(), entryId: parent.origin },
      text: "Retain this result", sourceEntryIds: ["source"], createdAt: Date.now(),
    };
    const send = parent.api.sendMessage.bind(parent.api);
    const file = parent.session.sessionManager.getSessionFile()!;
    const backup = `${file}.saved`;
    const sender = vi.spyOn(parent.api, "sendMessage").mockImplementationOnce((message, options) => {
      renameSync(file, backup); mkdirSync(file);
      try { send(message, options); } finally { rmdirSync(file); renameSync(backup, file); }
    });
    await expect(parent.channel.deliver(delivery, () => true)).rejects.toThrow("not durably persisted");
    expect(receipts(parent)).toHaveLength(1);
    expect(readFileSync(file, "utf8")).not.toContain(delivery.deliveryId);
    await expect(parent.channel.deliver(delivery, () => true)).rejects.toThrow("only in memory");
    expect(sender).toHaveBeenCalledOnce();
    expect(parent.errors).toHaveLength(1);
  });
});
