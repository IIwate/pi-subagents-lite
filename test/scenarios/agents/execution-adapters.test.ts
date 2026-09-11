import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT, JsonlSessionRepo, MemorySessionRepo, value, type Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore,
  type Context as ProviderContext, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { HarnessDriver, type HarnessDriverOptions } from "../../../src/drivers/harness-driver.js";
import { TaskEngine } from "../../../src/engine/task-engine.js";
import type { TaskBinding } from "../../../src/engine/contracts.js";
import type { TaskPolicy } from "../../../src/domain/policy.js";
import { createTestHarness, type TestHarness } from "../../support/harness.js";

const context = BACKGROUND_CONTEXT;

describe("Execution adapters", () => {
  let resources: TestHarness;
  let directory: string;
  let provider: ReturnType<typeof fauxProvider>;
  let models: ReturnType<typeof createModels>;

  beforeEach(() => {
    resources = createTestHarness();
    directory = resources.createTempDir("pi-execution-adapters-");
    provider = fauxProvider({ provider: "workers", api: "workers", tokensPerSecond: 100000,
      models: [{ id: "one", reasoning: true }, { id: "two", reasoning: true }] });
    models = createModels({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore() });
    models.setProvider(provider.provider);
  });
  afterEach(() => resources.dispose());

  function binding(taskId: string, policy: Partial<TaskPolicy> = {}, mode: TaskBinding["mode"] = "background"): TaskBinding {
    return {
      taskId, parent: { sessionId: "parent", entryId: "origin" }, mode, control: "autonomous",
      policy: {
        agent: "worker", model: { provider: "workers", id: "one" }, thinkingLevel: "high", tools: [],
        cwd: directory, systemPrompt: "Accepted worker policy", limits: { graceTurns: 1 }, ...policy,
      },
    };
  }

  async function driver(accepted: TaskBinding, options: Partial<HarnessDriverOptions> = {}) {
    const session = options.session ?? await new MemorySessionRepo().create({ parentSessionId: "parent" }, context);
    const result = await HarnessDriver.open({ session, models, binding: accepted,
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
      compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1000 }, ...options });
    resources.onDispose(() => result.close());
    return result;
  }

  function engine(limits = { default: 1, providers: { workers: 1 } }) {
    const result = new TaskEngine(limits, { deliver: async () => ({ status: "pending", reason: "busy" }) });
    resources.onDispose(() => result.close());
    return result;
  }

  async function settled(tasks: TaskEngine, taskId: string): Promise<void> {
    const done = Promise.withResolvers<void>();
    const check = () => { if (tasks.get(taskId).state.status === "settled") done.resolve(); };
    const unsubscribe = tasks.subscribe(check);
    resources.onDispose(unsubscribe);
    check();
    await done.promise;
    unsubscribe();
  }

  function fileRepository() {
    const env = new NodeExecutionEnv({ cwd: directory });
    const repository = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(directory, "sessions") });
    resources.onDispose(() => env.cleanup(context));
    resources.onDispose(() => repository.close(context));
    return repository;
  }

  it("holds actual quota after an observer abort and applies queued steering with the accepted policy", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const requests: ProviderContext[] = [];
    const options: Array<SimpleStreamOptions | undefined> = [];
    const respond = (request: ProviderContext, streamOptions?: SimpleStreamOptions) => {
      requests.push(request);
      options.push(streamOptions);
      if (JSON.stringify(request.messages).includes("hold") && !request.messages.some(message => message.role === "toolResult")) {
        return fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("Finished");
    };
    provider.setResponses(Array.from({ length: 6 }, () => respond));
    const tasks = engine();
    const first = await driver(binding("first", { tools: ["probe"] }), { tools: [{
      name: "probe", label: "Probe", description: "Hold an admitted tool.", parameters: Type.Object({}), replay: "never",
      execute: async () => { entered.resolve(); await release.promise; return { content: [{ type: "text", text: "Tool finished" }], details: {} }; },
    }] });
    const policy = binding("second", { model: { provider: "workers", id: "two" }, limits: { graceTurns: 1, maxTokens: 73 } });
    const second = await driver(policy);
    const third = await driver(binding("third"));
    resources.onDispose(() => { release.resolve(); });
    await tasks.accept(first, { text: "hold" });
    await entered.promise;
    await tasks.accept(second, { text: "Alternate model" });
    await tasks.accept(third, { text: "Same model" });
    const observation = new AbortController();
    const waiting = tasks.wait("first", observation.signal);
    observation.abort(new Error("Observer left"));
    await expect(waiting).rejects.toThrow("Observer left");
    expect(tasks.get("second").state.status).toBe("queued");
    expect(tasks.get("third").state.status).toBe("queued");

    const removed = await tasks.queue("second", "steer", { text: "Withdraw this" });
    const queued = await tasks.queue("second", "steer", { text: "Keep this correction" });
    expect(await tasks.cancelQueued("second", removed)).toBe("cancelled");
    tasks.setLimits({ default: 1, providers: { workers: 2 } });
    await tasks.wait("second");
    expect(tasks.get("first").state.status).toBe("running");
    expect(tasks.get("third").state.status).toBe("queued");
    expect(JSON.stringify(requests[1].messages)).toContain("Keep this correction");
    expect(JSON.stringify(requests[1].messages)).not.toContain("Withdraw this");
    expect(requests[1].systemPrompt).toBe(policy.policy.systemPrompt);
    expect(requests[1].tools ?? []).toEqual([]);
    expect(options[1]).toMatchObject({ reasoning: "high", maxTokens: 73 });
    expect(await tasks.cancelQueued("second", queued)).toBe("already_consumed");
    expect(tasks.get("second").control).toBe("autonomous");
    const settledOperation = tasks.get("second").operationId;
    tasks.setLimits({ default: 1, providers: { workers: 1 } });
    await expect(tasks.continue("second", { text: "Blocked continuation" })).rejects.toThrow("Concurrency limit reached");
    expect(tasks.get("second").operationId).toBe(settledOperation);
    expect((await second.snapshot()).operation).toBeUndefined();
    release.resolve();
    await Promise.all([tasks.wait("first"), tasks.wait("third")]);
  });

  it("keeps foreground steering autonomous and detaches only after durable takeover", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Original selected result"), fauxAssistantMessage("Continued result"),
    ]);
    const tasks = engine();
    const child = await driver(binding("interactive", { tools: ["probe"] }, "foreground"), { tools: [{
      name: "probe", label: "Probe", description: "Pause a tool.", parameters: Type.Object({}), replay: "never",
      execute: async () => { entered.resolve(); await release.promise; return { content: [{ type: "text", text: "Done" }], details: {} }; },
    }] });
    resources.onDispose(() => { release.resolve(); });
    const accepted = await tasks.accept(child, { text: "Start" });
    await entered.promise;
    const foreground = tasks.wait("interactive");
    await tasks.queue("interactive", "steer", { text: "A small correction" });
    expect(tasks.get("interactive").control).toBe("autonomous");
    await tasks.takeOver("interactive");
    expect((await foreground).state.status).toBe("running");
    expect(child.store.binding.control).toBe("manual");
    release.resolve();
    await settled(tasks, "interactive");
    expect(await child.store.deliveries()).toEqual([]);
    const selected = (await child.snapshot()).messages.filter(message => message.role === "assistant" && message.text);
    const continuation = await tasks.continue("interactive", { text: "Continue" });
    expect(continuation.operationId).not.toBe(accepted.operationId);
    await settled(tasks, "interactive");
    await tasks.deliverSelection("interactive", selected);
    const saved = await child.store.deliveries();
    expect(saved).toHaveLength(1);
    expect(saved[0].delivery.kind).toBe("selection");
    expect(saved[0].delivery.text).toContain("Original selected result");
    expect(saved[0].delivery.text).not.toContain("Continued result");
  });

  it("restores accepted work and keeps each operation's result and delivery identity separate", async () => {
    const repository = fileRepository();
    const session = await repository.create({ cwd: directory, parentSessionId: "parent" }, context);
    const first = await driver(binding("restored"), { session });
    const operationId = await first.accept({ text: "Persist this work" });
    const queuedId = await first.queue("steer", { text: "Persist this correction" });
    await first.close();

    const reopened = await driver(binding("unused"), { session: await repository.open(session.metadata, context), binding: undefined });
    const tasks = engine();
    await tasks.restore(reopened);
    expect(provider.state.callCount).toBe(0);
    expect((await reopened.snapshot()).queued.map(item => item.entryId)).toEqual([queuedId]);
    provider.setResponses([fauxAssistantMessage("First operation output"), fauxAssistantMessage("", { stopReason: "error", errorMessage: "Permanent failure" })]);
    tasks.resume("restored");
    await tasks.wait("restored");
    expect(tasks.get("restored").operationId).toBe(operationId);
    await tasks.continue("restored", { text: "Second operation" });
    const second = await tasks.wait("restored");
    expect(second.state).toMatchObject({ status: "settled", outcome: { status: "error", error: "Permanent failure", result: "" } });
    const saved = await reopened.store.deliveries();
    expect(saved).toHaveLength(2);
    expect(new Set(saved.map(item => item.delivery.deliveryId)).size).toBe(2);
    expect(saved.find(item => item.delivery.operationId === second.operationId)?.delivery.text).not.toContain("First operation output");
    await tasks.close();

    const restored = await driver(binding("unused"), { session: await repository.open(session.metadata, context), binding: undefined });
    const restoredEngine = engine();
    await restoredEngine.restore(restored);
    expect(await restored.store.deliveries()).toEqual(saved);
    expect(provider.state.callCount).toBe(2);
  });

  it("closes admitted effects before releasing ownership and never replays an unsafe interrupted tool", async () => {
    const repository = fileRepository();
    const session = await repository.create({ cwd: directory, parentSessionId: "parent" }, context);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fileClosed = Promise.withResolvers<void>();
    let first: HarnessDriver | undefined;
    let reentrantClose: Promise<void> | undefined;
    const closeSession = session.close.bind(session);
    vi.spyOn(session, "close").mockImplementation(async ctx => {
      reentrantClose = first?.close();
      await closeSession(ctx); fileClosed.resolve();
    });
    const execute = vi.fn(async () => {
      entered.resolve(); await release.promise;
      return { content: [{ type: "text" as const, text: "External effect completed" }], details: {} };
    });
    const tools: HarnessDriverOptions["tools"] = [{ name: "effect", label: "Effect", description: "Perform a non-repeatable effect.",
      parameters: Type.Object({}), replay: "never", execute }];
    provider.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Recovered with an unknown effect")]);
    first = await driver(binding("interrupted", { tools: ["effect"] }), { session, tools });
    resources.onDispose(() => { release.resolve(); });
    const operationId = await first.accept({ text: "Run the effect" });
    const run = first.drive(operationId);
    const failedRun = expect(run).rejects.toThrow();
    await entered.promise;
    let fullyClosed = false;
    const ownedClose = first.close();
    const closing = ownedClose.then(() => { fullyClosed = true; });
    await fileClosed.promise;
    expect(reentrantClose).toBe(ownedClose);
    expect(fullyClosed).toBe(false);
    release.resolve();
    await Promise.all([failedRun, closing]);

    const recovered = await driver(binding("unused"), { session: await repository.open(session.metadata, context), binding: undefined, tools });
    expect((await recovered.snapshot()).operation?.operationId).toBe(operationId);
    expect((await recovered.drive(operationId)).kind).toBe("settled");
    expect(execute).toHaveBeenCalledOnce();
    expect((await recovered.snapshot()).messages.some(message => message.role === "toolResult" && message.text.includes("external outcome is unknown"))).toBe(true);
  });

  it("enforces graceful and hard turn limits through native checkpoints", async () => {
    const requests: ProviderContext[] = [];
    provider.setResponses(Array.from({ length: 5 }, () => (request: ProviderContext) => {
      requests.push(request);
      return fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" });
    }));
    const child = await driver(binding("limited", { tools: ["probe"], limits: { maxTurns: 1, graceTurns: 1 } }), { tools: [{
      name: "probe", label: "Probe", description: "Return a value.", parameters: Type.Object({}), replay: "safe",
      execute: async () => ({ content: [{ type: "text", text: "Done" }], details: {} }),
    }] });
    const result = await child.drive(await child.accept({ text: "Keep calling tools" }));
    expect(result).toMatchObject({ kind: "settled", result: { outcome: { status: "aborted" } } });
    expect(provider.state.callCount).toBe(2);
    expect(JSON.stringify(requests[1].messages)).toContain("You have reached your turn limit");
  });

  it("rejects corrupt persisted policy before model execution and closes the supplied session", async () => {
    const session: Session = await new MemorySessionRepo().create({ parentSessionId: "parent" }, context);
    await session.setValue(value("subagents-lite.v3", "task"), { ...binding("corrupt"), policy: { ...binding("corrupt").policy, tools: [42] } }, context);
    const close = vi.spyOn(session, "close");
    await expect(HarnessDriver.open({ session, models })).rejects.toThrow("Invalid task data string");
    expect(close).toHaveBeenCalledOnce();
    expect(provider.state.callCount).toBe(0);
  });
});
