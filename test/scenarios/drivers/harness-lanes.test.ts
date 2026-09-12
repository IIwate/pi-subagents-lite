import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  getOrThrow,
  JsonlSessionRepo,
  MemorySessionRepo,
  type AgentHarnessTool,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Context as ProviderContext,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createTestHarness, type TestHarness } from "../../support/harness.js";

const context = BACKGROUND_CONTEXT;

describe("Native Harness lane contracts", () => {
  let resources: TestHarness;

  beforeEach(() => { resources = createTestHarness(); });
  afterEach(() => resources.dispose());

  function createProviders() {
    const main = fauxProvider({
      provider: "harness-main", api: "harness-main", tokensPerSecond: 100000,
      models: [{ id: "main", reasoning: true }],
    });
    const child = fauxProvider({
      provider: "harness-child", api: "harness-child", tokensPerSecond: 100000,
      models: [{ id: "child", reasoning: true }],
    });
    const models = createModels({
      credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    });
    models.setProvider(main.provider);
    models.setProvider(child.provider);
    return { main, child, models };
  }

  async function attach(
    session: Session,
    providers: ReturnType<typeof createProviders>,
    tools: AgentHarnessTool<undefined>[] = [],
  ) {
    let close = () => session.close(context);
    resources.onDispose(() => close());
    const result = await AgentHarness.create<undefined>({
      session, models: providers.models, model: providers.main.models[0], tools,
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
      compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1000 },
    }, context);
    close = () => result.harness.close(context);
    return result;
  }

  it("runs independent lanes and consumes steering after the active tool finishes", async () => {
    const providers = createProviders();
    const mainEntered = Promise.withResolvers<void>();
    const toolEntered = Promise.withResolvers<void>();
    const releaseMain = Promise.withResolvers<void>();
    const releaseTool = Promise.withResolvers<void>();
    const mainRequests: ProviderContext[] = [];
    const childRequests: ProviderContext[] = [];
    const childOptions: Array<SimpleStreamOptions | undefined> = [];

    providers.main.setResponses([async request => {
      mainRequests.push(request);
      mainEntered.resolve();
      await releaseMain.promise;
      return fauxAssistantMessage("Main finished");
    }]);
    providers.child.setResponses([
      (request, options) => {
        childRequests.push(request);
        childOptions.push(options);
        return fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" });
      },
      (request, options) => {
        childRequests.push(request);
        childOptions.push(options);
        return fauxAssistantMessage("Child finished after steering");
      },
    ]);

    const session = await new MemorySessionRepo().create({}, context);
    const { harness } = await attach(session, providers, [{
      name: "probe", label: "Probe", description: "Hold an offline tool operation.",
      parameters: Type.Object({}), replay: "never",
      execute: async () => {
        toolEntered.resolve();
        await releaseTool.promise;
        return { content: [{ type: "text", text: "Probe finished" }], details: {} };
      },
    }]);
    resources.onDispose(harness.hooks.on("transform_context", ({ lane }) => ({
      systemPrompt: `Policy for ${lane}`,
    })));

    const main = await harness.lane("main", context);
    const child = await harness.lane("child", context);
    await main.setActiveTools([], context);
    await child.setModel({ provider: "harness-child", modelId: "child" }, context);
    await child.setThinkingLevel("high", context);

    const mainRun = main.prompt("Main work", undefined, context);
    const childRun = child.prompt("Child work", undefined, context);
    resources.onDispose(async () => {
      releaseMain.resolve();
      releaseTool.resolve();
      await Promise.allSettled([mainRun, childRun]);
    });
    await Promise.race([
      Promise.all([mainEntered.promise, toolEntered.promise]),
      mainRun.then(() => { throw new Error("Main settled before both lanes entered execution"); }),
      childRun.then(() => { throw new Error("Child settled before both lanes entered execution"); }),
    ]);

    const withdrawn = getOrThrow(await child.steer("Withdraw this instruction", undefined, context));
    const queued = getOrThrow(await child.steer("Keep the final response concise", undefined, context));
    const watch = await child.watch(context);
    resources.onDispose(() => watch.unsubscribe());
    expect(watch.snapshot.queues.map(item => item.entryId)).toEqual([withdrawn.entryId, queued.entryId]);
    expect(getOrThrow(await child.cancelQueued(withdrawn.entryId, context)).kind).toBe("cancelled");

    releaseTool.resolve();
    expect(getOrThrow(await childRun).status).toBe("completed");
    expect((await main.inspectExecution(context)).current).not.toBeNull();
    expect(childRequests).toHaveLength(2);
    expect(JSON.stringify(childRequests[1].messages)).toContain("Keep the final response concise");
    expect(JSON.stringify(childRequests[1].messages)).toContain("Probe finished");
    expect(JSON.stringify(childRequests[1].messages)).not.toContain("Withdraw this instruction");
    expect(childOptions.map(options => options?.reasoning)).toEqual(["high", "high"]);
    expect(childRequests[1].systemPrompt).toBe("Policy for child");
    expect(childRequests[1].tools?.map(tool => tool.name)).toEqual(["probe"]);
    expect(mainRequests[0].systemPrompt).toBe("Policy for main");
    expect(mainRequests[0].tools ?? []).toEqual([]);
    expect(getOrThrow(await child.cancelQueued(queued.entryId, context)).kind).toBe("already_consumed");

    releaseMain.resolve();
    expect(getOrThrow(await mainRun).status).toBe("completed");
    expect(JSON.stringify(await main.findEntries(undefined, context))).not.toContain("Child finished after steering");
  });

  it("requires application routing and deduplication when copying child results into a parent lane", async () => {
    const session = await new MemorySessionRepo().create({}, context);
    const { harness } = await attach(session, createProviders());
    const main = await harness.lane("main", context);
    const root = await main.appendMessage({ role: "user", content: "Root", timestamp: Date.now() }, context);
    const origin = await main.appendMessage({ role: "user", content: "Task A", timestamp: Date.now() }, context);
    const child = await harness.lane("child-a", { createAt: origin }, context);
    const resultId = await child.appendCustomEntry("subagent.result", {
      taskId: "task-a", status: "completed", result: "Result A",
    }, context);

    const before = await main.findEntries(undefined, context);
    expect(before.map(entry => entry.id)).toContain(origin);
    expect(before.map(entry => entry.id)).not.toContain(resultId);

    getOrThrow(await main.navigateTree(root, undefined, context));
    const branchB = await main.appendMessage({ role: "user", content: "Task B", timestamp: Date.now() }, context);
    const delivery = { taskId: "task-a", resultEntryId: resultId, result: "Result A" };
    const first = await main.appendCustomEntry("subagent.delivery", delivery, context);
    const second = await main.appendCustomEntry("subagent.delivery", delivery, context);
    const after = await main.findEntries(undefined, context);

    expect(after.map(entry => entry.id)).toContain(branchB);
    expect(after.map(entry => entry.id)).not.toContain(origin);
    expect(after.map(entry => entry.id)).not.toContain(resultId);
    expect(after.filter(entry => entry.type === "custom" && entry.customType === "subagent.delivery")).toHaveLength(2);
    expect(first).not.toBe(second);
    expect((await child.findEntries(undefined, context)).map(entry => entry.id)).toEqual([resultId, origin, root]);
  });

  it("restores an accepted operation and queued input from JSONL without starting execution on attachment", async () => {
    const directory = resources.createTempDir("pi-native-session-");
    const fileSystem = new NodeExecutionEnv({ cwd: directory });
    resources.onDispose(() => fileSystem.cleanup(context));
    const repository = new JsonlSessionRepo({ fileSystem, sessionsRoot: join(directory, "sessions") });
    resources.onDispose(() => repository.close(context));
    const providers = createProviders();
    const session = await repository.create({ cwd: directory }, context);
    const initial = await attach(session, providers);
    const child = await initial.harness.lane("child", context);
    await child.setModel({ provider: "harness-child", modelId: "child" }, context);
    const accepted = getOrThrow(await child.accept({ kind: "prompt", prompt: "Persisted task" }, context));
    const queued = getOrThrow(await child.steer("Persisted correction", undefined, context));
    await initial.harness.close(context);

    const restored = await attach(await repository.open(session.metadata, context), providers);
    expect(restored.open).toEqual([expect.objectContaining({ lane: "child", operationId: accepted.operationId })]);
    expect(providers.child.state.callCount).toBe(0);
    const resumedLane = await restored.harness.lane("child", context);
    const watch = await resumedLane.watch(context);
    resources.onDispose(() => watch.unsubscribe());
    expect(watch.snapshot.queues.map(item => item.entryId)).toEqual([queued.entryId]);
    const requests: ProviderContext[] = [];
    providers.child.setResponses([request => {
      requests.push(request);
      return fauxAssistantMessage("Restored result");
    }]);

    const driven = getOrThrow(await resumedLane.drive({ operationId: accepted.operationId }, context));
    expect(driven.kind).toBe("settled");
    expect(await resumedLane.getResult(accepted.operationId, context)).toMatchObject({ status: "completed" });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0].messages)).toContain("Persisted task");
    expect(JSON.stringify(requests[0].messages)).toContain("Persisted correction");
    await restored.harness.close(context);

    const settled = await attach(await repository.open(session.metadata, context), providers);
    expect(settled.open).toEqual([]);
    const settledLane = await settled.harness.lane("child", context);
    expect(await settledLane.getResult(accepted.operationId, context)).toMatchObject({
      operationId: accepted.operationId, status: "completed",
    });
    expect(JSON.stringify(await settledLane.findEntries(undefined, context))).toContain("Restored result");
    expect(providers.child.state.callCount).toBe(1);
  });
});
