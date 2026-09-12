import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ExtensionRuntime } from "../../src/runtime.js";
import { registerTools } from "../../src/registration.js";
import { setupEventListeners } from "../../src/events.js";
import { executeAgentTool, executeStopAgentTool } from "../../src/agents/tool-execution.js";
import { executeAgentStatusTool } from "../../src/agents/agent-status.js";
import { PiResources } from "../../src/drivers/pi-resources.js";
import { RESULT_MESSAGE_TYPE } from "../../src/drivers/pi-delivery-channel.js";
import { createTestHarness, type TestHarness } from "../support/harness.js";

describe("ExtensionRuntime ownership", () => {
  let harness: TestHarness;
  beforeEach(() => { harness = createTestHarness(); });
  afterEach(() => harness.dispose());

  async function host(name: string, agentBody = "tools: [read]\nextensions: false\nskills: false") {
    const directory = harness.createTempDir(`pi-runtime-${name}-`);
    mkdirSync(join(directory, "agents"));
    writeFileSync(join(directory, "agents", "worker.md"), `---\nname: worker\ndescription: ${name} worker\nregistered_tools: [read]\n${agentBody}\n---\nComplete the delegated task.\n`);
    const parentProvider = fauxProvider({ provider: `${name}-parent`, api: `${name}-parent`, tokensPerSecond: 100000, models: [{ id: "main" }] });
    const worker = fauxProvider({ provider: `${name}-worker`, api: `${name}-worker`, tokensPerSecond: 100000, models: [{ id: "child" }] });
    const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
      modelsPath: null, refreshOnCreate: false });
    models.registerNativeProvider(parentProvider.provider); models.registerNativeProvider(worker.provider);
    let runtime!: ExtensionRuntime;
    let api!: ExtensionAPI;
    const errors: string[] = [];
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        api = pi; runtime = new ExtensionRuntime(pi, { agentDir: directory });
        registerTools(pi, runtime); setupEventListeners(pi, runtime);
      }],
    });
    await loader.reload();
    const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    writeFileSync(join(directory, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
    const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: models,
      model: parentProvider.getModel(), sessionManager: SessionManager.create(directory, join(directory, "parent")),
      settingsManager: settings, resourceLoader: loader });
    harness.onDispose(async () => { await session.abort(); session.dispose(); await settings.flush(); });
    harness.onDispose(async () => { if (runtime.active) await runtime.dispose(); });
    await session.bindExtensions({ onError: error => errors.push(error.error) });
    parentProvider.setResponses([fauxAssistantMessage("Parent ready")]);
    await session.prompt("Parent private context");
    runtime.store.mutate.routing.configureAgentProviderAccess("worker", worker.provider.id);
    return { directory, runtime, session, parentProvider, worker, errors, api };
  }

  type Host = Awaited<ReturnType<typeof host>>;
  async function spawn(parent: Host, text = "Delegated task", background = true) {
    await executeAgentTool(parent.runtime, "call", { agent: "worker", prompt: text, model: `${parent.worker.provider.id}/child`,
      run_in_background: background }, undefined, undefined, parent.runtime.context);
    return parent.runtime.engine.list().at(-1)!;
  }
  function settled(runtime: ExtensionRuntime, id: string): Promise<void> {
    const done = Promise.withResolvers<void>();
    const check = () => { if (runtime.engine.get(id).state.status === "settled") done.resolve(); };
    const stop = runtime.engine.subscribe(check); harness.onDispose(stop);
    check(); return done.promise.finally(stop);
  }
  function resultEntries(parent: Host) {
    return parent.session.sessionManager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === RESULT_MESSAGE_TYPE);
  }
  function holdRead() {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    harness.onDispose(() => release.resolve());
    const open = PiResources.open;
    vi.spyOn(PiResources, "open").mockImplementation(async options => {
      const resources = await open(options);
      const read = resources.tools.find(tool => tool.name === "read")!;
      read.execute = async () => { entered.resolve(); await release.promise; return { content: [{ type: "text", text: "Checkpoint released" }], details: {} }; };
      return resources;
    });
    return { entered, release };
  }

  it("runs the registered Agent tool on the official parent and durably delivers its native result", async () => {
    const parent = await host("entry");
    const requests: string[] = [];
    parent.worker.setResponses([request => { requests.push(JSON.stringify(request)); return fauxAssistantMessage("Native child result"); }]);
    parent.parentProvider.setResponses([
      fauxAssistantMessage(fauxToolCall("Agent", { agent: "worker", prompt: "Work independently", model: "entry-worker/child", run_in_background: true }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Delegated"), fauxAssistantMessage("Result consumed"),
    ]);
    await parent.session.prompt("Delegate a task");
    const task = parent.runtime.engine.list()[0];
    expect(task).toBeDefined();
    await settled(parent.runtime, task.taskId);
    await parent.session.waitForIdle(); await parent.runtime.flushDeliveries(); await parent.session.waitForIdle();
    expect(resultEntries(parent)).toHaveLength(1);
    await parent.runtime.source!.refresh();
    expect(parent.runtime.source!.getRecord(task.taskId)?.stats.contextPercent).toEqual(expect.any(Number));
    expect(readFileSync(parent.session.sessionManager.getSessionFile()!, "utf8")).toContain("Native child result");
    expect(requests[0]).not.toContain("Parent private context");
    expect(parent.errors).toEqual([]);
  });

  it("isolates catalogue, accepted policy, configuration, and shutdown across two runtimes", async () => {
    const first = await host("first"); const second = await host("second");
    const gate = holdRead();
    first.runtime.store.mutate.concurrency.setDefault(1);
    first.worker.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }), { stopReason: "toolUse" }), fauxAssistantMessage("First done")]);
    second.worker.setResponses([fauxAssistantMessage("Second done")]);
    second.parentProvider.setResponses([fauxAssistantMessage("Second result received")]);
    const running = await spawn(first); await gate.entered.promise;
    const queued = await spawn(first, "Queued task");
    expect(queued.state.status).toBe("queued");
    const policy = first.runtime.engine.get(queued.taskId).policy;
    first.runtime.catalogue.registerAgents(new Map(), { disableDefaultAgents: true });
    first.runtime.store.mutate.agent.setGraceTurns(15);
    expect(first.runtime.engine.get(queued.taskId).policy).toBe(policy);
    expect(second.runtime.catalogue.getAgentConfig("worker")?.description).toBe("second worker");
    expect(second.runtime.store.agent.graceTurns).toBe(6);
    const other = await spawn(second); await settled(second.runtime, other.taskId);
    const closing = first.runtime.dispose();
    expect(() => first.runtime.store.mutate.agent.setGraceTurns(2)).toThrow("closed runtime");
    gate.release.resolve(); await closing;
    expect(second.runtime.engine.get(other.taskId).state).toMatchObject({ status: "settled", outcome: { result: "Second done" } });
    expect(second.runtime.active).toBe(true);
    expect(resultEntries(first)).toHaveLength(0);
    expect(running.taskId).not.toBe(other.taskId);
  });

  it("discovers accepted operations from native files after reload and resumes only through explicit input", async () => {
    const parent = await host("reload");
    const gate = holdRead();
    parent.runtime.store.mutate.concurrency.setDefault(1);
    parent.worker.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "wait" }), { stopReason: "toolUse" }), fauxAssistantMessage("Resumed report")]);
    const running = await spawn(parent); await gate.entered.promise;
    const queued = await spawn(parent, "Restore this accepted task");
    const closing = parent.runtime.dispose(); gate.release.resolve(); await closing;
    const calls = parent.worker.state.callCount;
    const replacement = new ExtensionRuntime(parent.api, { agentDir: parent.directory });
    harness.onDispose(() => replacement.dispose());
    await replacement.start(parent.session.extensionRunner!.createContext());
    expect(replacement.engine.get(queued.taskId).operationId).toBe(queued.operationId);
    expect(replacement.engine.get(running.taskId).operationId).toBe(running.operationId);
    expect(replacement.engine.get(running.taskId).state.status).toBe("waiting");
    expect(replacement.engine.get(queued.taskId).state.status).toBe("waiting");
    expect(parent.worker.state.callCount).toBe(calls);
    parent.worker.setResponses([fauxAssistantMessage("Resumed report")]);
    parent.parentProvider.setResponses([fauxAssistantMessage("Resumed result received")]);
    expect(await replacement.source!.dispatch({ type: "steer", taskId: queued.taskId, operationId: queued.operationId,
      input: { text: "Continue the accepted task" } })).toMatchObject({ accepted: true });
    await settled(replacement, queued.taskId);
    const status = await executeAgentStatusTool(replacement, "status", { agent_id: queued.taskId }, undefined, undefined, replacement.context);
    expect(status.content[0].text).toContain("Resumed report");
    expect(replacement.engine.get(queued.taskId).operationId).toBe(queued.operationId);
  });

  it("waits for late resource preparation, rejects its publication, and continues cleanup after UI failure", async () => {
    const parent = await host("late");
    const prepared = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    harness.onDispose(() => release.resolve());
    const open = PiResources.open;
    let childResources!: PiResources;
    vi.spyOn(PiResources, "open").mockImplementation(async options => {
      childResources = await open(options); prepared.resolve(); await release.promise; return childResources;
    });
    const pending = spawn(parent);
    const rejected = expect(pending).rejects.toThrow("closed");
    await prepared.promise;
    const close = vi.spyOn(childResources, "close");
    vi.spyOn(parent.runtime.navigator!, "dispose").mockImplementationOnce(() => { throw new Error("Host UI already disposed"); });
    const closing = parent.runtime.dispose();
    const cleanupError = expect(closing).rejects.toThrow("cleanup failed");
    release.resolve(); await rejected; await cleanupError;
    expect(close).toHaveBeenCalledOnce();
    expect(parent.runtime.engine.list()).toEqual([]);
    expect(parent.worker.state.callCount).toBe(0);
    parent.parentProvider.setResponses([fauxAssistantMessage("Parent remains usable")]);
    await parent.session.prompt("Continue parent work");
    expect(parent.session.messages.at(-1)).toMatchObject({ role: "assistant" });
  });

  it("keeps steering autonomous and detaches foreground observation only after explicit takeover", async () => {
    const parent = await host("control"); const gate = holdRead();
    parent.worker.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "wait" }), { stopReason: "toolUse" }), fauxAssistantMessage("Manual final result")]);
    const foreground = executeAgentTool(parent.runtime, "foreground", { agent: "worker", prompt: "Work", model: "control-worker/child" }, undefined, undefined, parent.runtime.context);
    await gate.entered.promise;
    const task = parent.runtime.engine.list()[0];
    await parent.runtime.engine.queue(task.taskId, "steer", { text: "Refine the result" });
    expect(parent.runtime.engine.get(task.taskId).control).toBe("autonomous");
    await parent.runtime.engine.takeOver(task.taskId);
    expect((await foreground).content[0].text).toContain("User took over");
    gate.release.resolve(); await settled(parent.runtime, task.taskId);
    await parent.runtime.flushDeliveries();
    expect(resultEntries(parent)).toEqual([]);
    const stop = await executeStopAgentTool(parent.runtime, "stop", { agent_id: task.taskId }, undefined, undefined, parent.runtime.context);
    expect(stop.content[0].text).toContain("already completed");
  });

  it("adapts child extension hooks and state while keeping durable results readable without the extension", async () => {
    const parent = await host("resources", "tools: [probe/inspect]\nextensions: [probe]\nskills: false");
    mkdirSync(join(parent.directory, "extensions"));
    const extension = join(parent.directory, "extensions", "probe.ts");
    writeFileSync(extension, `export default function (pi) {
      pi.on("session_start", () => pi.registerTool({
        name: "inspect", label: "Inspect", description: "Inspect child state", parameters: { type: "object", properties: {} },
        execute: async (_id, _args, _signal, _update, ctx) => {
          const state = ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "probe.state").at(-1).data;
          state.count++;
          pi.appendEntry("probe.state", state);
          return { content: [{ type: "text", text: JSON.stringify({ count: state.count, cwd: ctx.cwd, ui: ctx.hasUI }) }], details: {} };
        }
      }));
      pi.on("before_agent_start", event => ({ systemPrompt: event.systemPrompt + "\\nChild hook applied" }));
      pi.on("session_shutdown", () => pi.appendEntry("probe.shutdown", { saved: true }));
    }`);
    parent.session.sessionManager.appendCustomEntry("probe.state", { count: 4 });
    const requests: string[] = [];
    parent.worker.setResponses([
      fauxAssistantMessage(fauxToolCall("inspect", {}), { stopReason: "toolUse" }),
      request => { requests.push(JSON.stringify(request)); return fauxAssistantMessage("Persistent resource result"); },
    ]);
    const task = await spawn(parent, "Inspect isolated resources", false);
    expect(requests[0]).toContain("Child hook applied");
    expect(requests[0]).toContain('\\"count\\":5');
    expect(requests[0]).toContain('\\"ui\\":false');
    expect(parent.session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "probe.state").at(-1)).toMatchObject({ data: { count: 4 } });
    const ctx = parent.runtime.context;
    await parent.runtime.dispose();
    const taskRoot = join(parent.directory, "subagents-lite-v3", "sessions");
    const [taskFile] = globSync("**/*.jsonl", { cwd: taskRoot });
    expect(readFileSync(join(taskRoot, taskFile), "utf8")).toContain("probe.shutdown");
    writeFileSync(extension, "throw new Error('Child extension unavailable');");
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    const replacement = new ExtensionRuntime(parent.api, { agentDir: parent.directory });
    harness.onDispose(() => replacement.dispose());
    await replacement.start(ctx);
    expect(replacement.engine.list()).toEqual([]);
    expect(diagnostics).toHaveBeenCalled();
    const result = await executeAgentStatusTool(replacement, "status", { agent_id: task.taskId }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("Persistent resource result");
  });

  it("persists an explicit stop separately from a turn-budget abort", async () => {
    const parent = await host("stop"); const gate = holdRead();
    parent.worker.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "wait" }), { stopReason: "toolUse" })]);
    parent.parentProvider.setResponses([fauxAssistantMessage("Stopped result received")]);
    const task = await spawn(parent); await gate.entered.promise;
    await executeStopAgentTool(parent.runtime, "stop", { agent_id: task.taskId }, undefined, undefined, parent.runtime.context);
    expect(parent.runtime.engine.get(task.taskId).state.status).toBe("cancelling");
    gate.release.resolve(); await settled(parent.runtime, task.taskId);
    expect(parent.runtime.engine.get(task.taskId).state).toMatchObject({ status: "settled", outcome: { status: "stopped", stoppedBy: "agent" } });
  });

  it("continues after a provider failure and delivers the current operation result", async () => {
    const parent = await host("recovery");
    parent.parentProvider.setResponses([fauxAssistantMessage("Failure received"), fauxAssistantMessage("Recovery received")]);
    parent.worker.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider request failed" }),
      fauxAssistantMessage("Recovered result"),
    ]);
    const task = await spawn(parent);
    await parent.runtime.engine.wait(task.taskId);
    expect(parent.runtime.engine.get(task.taskId).state).toMatchObject({ status: "settled", outcome: { status: "error", error: "Provider request failed" } });
    expect(parent.worker.state.callCount).toBe(1);
    await parent.runtime.engine.continue(task.taskId, { text: "Continue after the provider failure" });
    await parent.runtime.engine.wait(task.taskId);
    expect(parent.runtime.engine.get(task.taskId).state).toEqual({ status: "settled", outcome: { status: "completed", result: "Recovered result" } });
    expect(parent.worker.state.callCount).toBe(2);
    const status = await executeAgentStatusTool(parent.runtime, "status", { agent_id: task.taskId }, undefined, undefined, parent.runtime.context);
    expect(status.content[0].text).toContain("Recovered result");
    const delivery = (await parent.runtime.engine.storedDeliveries(task.taskId)).at(-1)!.delivery;
    expect(delivery).toMatchObject({ operationId: parent.runtime.engine.get(task.taskId).operationId, status: "completed", text: "Recovered result" });
  });
});
