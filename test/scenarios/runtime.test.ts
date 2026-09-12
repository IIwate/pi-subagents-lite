import { existsSync, globSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore, type Context as ProviderContext } from "@earendil-works/pi-ai";
import { ExtensionRuntime } from "../../src/runtime.js";
import { registerTools } from "../../src/registration.js";
import { setupEventListeners } from "../../src/events.js";
import { executeAgentTool, executeStopAgentTool } from "../../src/agents/tool-execution.js";
import { executeAgentStatusTool } from "../../src/agents/agent-status.js";
import { PiResources } from "../../src/drivers/pi-resources.js";
import { RESULT_MESSAGE_TYPE } from "../../src/drivers/pi-delivery-channel.js";
import type { DeliverySelectorComponent } from "../../src/ui/delivery-selector.js";
import { createTestHarness, type TestHarness } from "../support/harness.js";
import { makeTui, makeUI, mountSelector } from "../support/navigator.js";

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
    const attach = PiResources.prototype.attach;
    vi.spyOn(PiResources.prototype, "attach").mockImplementation(async function (this: PiResources, childHarness, lane, store) {
      await attach.call(this, childHarness, lane, store);
      const read = this.tools.find(tool => tool.name === "read")!;
      read.execute = async () => { entered.resolve(); await release.promise; return { content: [{ type: "text", text: "Checkpoint released" }], details: {} }; };
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

  it.each([
    { forceBackground: true, requestedBackground: undefined, mode: "background" },
    { forceBackground: true, requestedBackground: false, mode: "background" },
    { forceBackground: true, requestedBackground: true, mode: "background" },
    { forceBackground: false, requestedBackground: undefined, mode: "foreground" },
    { forceBackground: false, requestedBackground: false, mode: "foreground" },
    { forceBackground: false, requestedBackground: true, mode: "background" },
  ])("accepts $mode execution with forceBackground=$forceBackground and run_in_background=$requestedBackground", async ({ forceBackground, requestedBackground, mode }) => {
    const parent = await host("mode"); const gate = holdRead();
    parent.runtime.store.mutate.agent.setForceBackground(forceBackground);
    parent.worker.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "wait" }), { stopReason: "toolUse" }), fauxAssistantMessage("Configured mode result")]);
    parent.parentProvider.setResponses([fauxAssistantMessage("Result received")]);
    const controller = new AbortController(); harness.onDispose(() => controller.abort());
    const execution = executeAgentTool(parent.runtime, "mode", {
      agent: "worker", prompt: "Work", model: "mode-worker/child",
      ...(requestedBackground === undefined ? {} : { run_in_background: requestedBackground }),
    }, controller.signal, undefined, parent.runtime.context);
    await gate.entered.promise;
    const task = parent.runtime.engine.list()[0];
    parent.runtime.store.mutate.agent.setForceBackground(!forceBackground);
    if (mode === "background") {
      const result = await execution;
      expect(result.content[0].text).toContain("The result will be delivered automatically");
      expect(result.content[0].text).toContain(`Agent ID: ${task.taskId}`);
      controller.abort();
    }
    gate.release.resolve(); await settled(parent.runtime, task.taskId);
    expect(parent.runtime.engine.get(task.taskId).state).toMatchObject({ status: "settled", outcome: { status: "completed", result: "Configured mode result" } });
    if (mode === "foreground") expect((await execution).content[0].text).toContain("Configured mode result");
    await parent.runtime.flushDeliveries(); await parent.session.waitForIdle();
    expect(resultEntries(parent)).toHaveLength(mode === "background" ? 1 : 0);
    if (mode === "background") expect(readFileSync(parent.session.sessionManager.getSessionFile()!, "utf8")).toContain("Configured mode result");
    expect(parent.errors).toEqual([]);
  });

  it("refreshes background guidance on the next parent turn and preserves identical effective prompts", async () => {
    const parent = await host("guidance");
    const prompts: string[] = [];
    for (const enabled of [false, true, true, false]) {
      parent.runtime.store.mutate.agent.setForceBackground(enabled);
      parent.parentProvider.setResponses([context => {
        prompts.push(context.systemPrompt ?? "");
        return fauxAssistantMessage("Settings applied");
      }]);
      await parent.session.prompt("Use the current agent settings");
    }
    expect(prompts[0]).toContain("use foreground when the result gates the next parent action");
    expect(prompts[1]).toContain("All Agent calls run in the background");
    expect(prompts[1]).toContain("end your turn and resume when it is delivered");
    expect(prompts[1]).toContain("Do not poll, sleep, or timeout-wait");
    expect(prompts[1]).not.toContain("use foreground");
    expect(prompts[1]).not.toContain("set `run_in_background: true`");
    expect(prompts[2]).toBe(prompts[1]);
    expect(prompts[3]).toBe(prompts[0]);
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

  it("restores session-start tools with saved child state before resuming a native checkpoint", async () => {
    const parent = await host("resume-tools", "tools: [read, probe/ffgrep]\nextensions: [probe]\nskills: false");
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(join(parent.directory, "extensions"));
    writeFileSync(join(parent.directory, "extensions", "probe.ts"), `export default function (pi) {
      pi.on("session_start", async (event, ctx) => {
        const branch = ctx.sessionManager.getBranch();
        const previous = branch.filter(entry => entry.type === "custom" && entry.customType === "probe.state").at(-1)?.data;
        const state = { reasons: [...(previous?.reasons ?? []), event.reason], hasUser: branch.some(entry => entry.type === "message" && entry.message.role === "user") };
        pi.appendEntry("probe.state", state);
        await Promise.resolve();
        pi.registerTool({ name: "ffgrep", label: "Search", description: "Inspect restored child state", parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [{ type: "text", text: JSON.stringify(state) }], details: {} }) });
      });
    }`);
    parent.session.sessionManager.appendCustomEntry("probe.state", { reasons: ["parent"] });
    const gate = holdRead();
    parent.worker.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "wait" }), { stopReason: "toolUse" })]);
    const task = await spawn(parent); await gate.entered.promise;
    const ctx = parent.runtime.context;
    const closing = parent.runtime.dispose(); gate.release.resolve(); await closing;
    parent.session.sessionManager.appendCustomEntry("probe.state", { reasons: ["changed parent"] });
    const calls = parent.worker.state.callCount;
    const replacement = new ExtensionRuntime(parent.api, { agentDir: parent.directory });
    harness.onDispose(() => replacement.dispose());
    await replacement.start(ctx);
    expect(replacement.engine.list()).toHaveLength(1);
    expect(replacement.engine.get(task.taskId)).toMatchObject({ operationId: task.operationId, policy: task.policy, state: { status: "waiting" } });
    expect(parent.worker.state.callCount).toBe(calls);
    const requests: ProviderContext[] = [];
    parent.worker.setResponses([
      request => { requests.push(request); return fauxAssistantMessage(fauxToolCall("ffgrep", {}), { stopReason: "toolUse" }); },
      request => { requests.push(request); return fauxAssistantMessage("Restored search result"); },
    ]);
    parent.parentProvider.setResponses([fauxAssistantMessage("Restored result received")]);
    expect(await replacement.source!.dispatch({ type: "steer", taskId: task.taskId, operationId: task.operationId,
      input: { text: "Continue searching with the restored tool" } })).toMatchObject({ accepted: true });
    await settled(replacement, task.taskId);
    await replacement.flushDeliveries(); await parent.session.waitForIdle();
    expect(requests[0].tools?.map(tool => tool.name)).toEqual(["read", "ffgrep"]);
    expect(requests[1].messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "ffgrep", isError: false,
      content: [{ type: "text", text: JSON.stringify({ reasons: ["parent", "new", "resume"], hasUser: true }) }] }));
    expect(replacement.engine.get(task.taskId).state).toMatchObject({ status: "settled", outcome: { status: "completed", result: "Restored search result" } });
    expect(warnings).not.toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalled();
    expect(parent.errors).toEqual([]);
  });

  it("refreshes accepted tools after asynchronous child registration across reload", async () => {
    const parent = await host("tool-refresh", "tools: [probe/mcp, probe/hidden]\nextensions: [probe]\nskills: false");
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(join(parent.directory, "extensions"));
    writeFileSync(join(parent.directory, "extensions", "probe.ts"), `export default function (pi) {
      const initial = { name: "mcp", label: "MCP", description: "Cached MCP metadata", parameters: { type: "object", properties: { stale: { type: "string" } }, required: ["stale"] },
        execute: async () => ({ content: [{ type: "text", text: "Stale implementation" }], details: {} }) };
      pi.registerTool(initial);
      pi.registerTool({ ...initial, name: "hidden" });
      let connect;
      let reason;
      const connected = new Promise(resolve => { connect = resolve; });
      const initialization = connected.then(() => {
        pi.registerTool({ ...initial, description: "Connected MCP metadata: " + reason,
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          execute: async (_id, args) => ({ content: [{ type: "text", text: "Connected " + reason + ": " + args.query }], details: {} }) });
        pi.registerTool({ ...initial, name: "unapproved" });
        pi.registerTool({ ...initial, name: "Agent" });
        pi.setActiveTools([...pi.getActiveTools(), "unapproved", "write", "Agent"]);
      });
      pi.on("session_start", event => { reason = event.reason; });
      pi.on("before_agent_start", async () => {
        pi.setActiveTools(pi.getActiveTools().filter(name => name !== "hidden"));
        connect();
        await initialization;
      });
    }`);
    const requests: ProviderContext[] = [];
    const responses = () => [
      (request: ProviderContext) => { requests.push(request); return fauxAssistantMessage(fauxToolCall("mcp", { query: "search" }), { stopReason: "toolUse" }); },
      (request: ProviderContext) => { requests.push(request); return fauxAssistantMessage("Refreshed tool result"); },
    ];
    parent.worker.setResponses(responses());
    const task = await spawn(parent, "Use connected tools", false);
    expect(task.policy.tools).toEqual(["mcp", "hidden"]);
    expect(requests[0].tools).toEqual([expect.objectContaining({ name: "mcp", description: "Connected MCP metadata: new",
      parameters: expect.objectContaining({ required: ["query"] }) })]);
    expect(requests[1].messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "mcp", isError: false,
      content: [{ type: "text", text: "Connected new: search" }] }));
    const ctx = parent.runtime.context;
    await parent.runtime.dispose();
    const replacement = new ExtensionRuntime(parent.api, { agentDir: parent.directory });
    harness.onDispose(() => replacement.dispose());
    await replacement.start(ctx);
    parent.worker.setResponses(responses());
    await replacement.engine.continue(task.taskId, { text: "Use refreshed tools after reload" });
    await replacement.engine.wait(task.taskId);
    expect(replacement.engine.get(task.taskId).policy.tools).toEqual(task.policy.tools);
    expect(requests[2].tools).toEqual([expect.objectContaining({ name: "mcp", description: "Connected MCP metadata: resume" })]);
    expect(requests[3].messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "mcp", isError: false,
      content: [{ type: "text", text: "Connected resume: search" }] }));
    expect(requests.map(request => request.tools?.map(tool => tool.name))).toEqual([["mcp"], ["mcp"], ["mcp"], ["mcp"]]);
    expect(warnings).not.toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalled();
    expect(parent.errors).toEqual([]);
  });

  it("hides expired native tasks on reload while preserving their saved results", async () => {
    const parent = await host("expired");
    parent.worker.setResponses([fauxAssistantMessage("Saved historical result")]);
    const task = await spawn(parent, "Keep the result available", false);
    const ctx = parent.runtime.context;
    await parent.runtime.dispose();
    const calls = parent.worker.state.callCount;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 7_200_000);
    const replacement = new ExtensionRuntime(parent.api, { agentDir: parent.directory });
    harness.onDispose(() => replacement.dispose());
    await replacement.start(ctx);
    expect(replacement.source!.listAgents()).toEqual([]);
    expect(replacement.source!.getRecord(task.taskId)).toBeUndefined();
    expect(replacement.engine.get(task.taskId).state).toMatchObject({ status: "settled", outcome: { status: "completed", result: "Saved historical result" } });
    expect(parent.worker.state.callCount).toBe(calls);
    const status = await executeAgentStatusTool(replacement, "status", { agent_id: task.taskId }, undefined, undefined, ctx);
    expect(status.content[0].text).toContain("Saved historical result");
    expect(parent.errors).toEqual([]);
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
    unlinkSync(extension);
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    const replacement = new ExtensionRuntime(parent.api, { agentDir: parent.directory });
    harness.onDispose(() => replacement.dispose());
    await replacement.start(ctx);
    expect(replacement.engine.list()).toEqual([]);
    expect(diagnostics).toHaveBeenCalledWith("[subagents]", expect.stringContaining("Extension path does not exist"));
    const result = await executeAgentStatusTool(replacement, "status", { agent_id: task.taskId }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("Persistent resource result");
  });

  it("filters child tools within the accepted ceiling before requests and restores the saved subset", async () => {
    const parent = await host("tool-filter", "tools: [read, probe/ask_user_question]\nextensions: [probe]\nskills: false");
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    mkdirSync(join(parent.directory, "extensions"));
    writeFileSync(join(parent.directory, "input.txt"), "Readable without UI");
    writeFileSync(join(parent.directory, "extensions", "probe.ts"), `export default function (pi) {
      pi.registerTool({ name: "ask_user_question", label: "Ask", description: "Ask through the UI", parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "Question asked" }], details: {} }) });
      pi.on("before_agent_start", (_event, ctx) => {
        const active = pi.getActiveTools();
        if (!ctx.hasUI) pi.setActiveTools(active.filter(name => name !== "ask_user_question"));
        pi.setActiveTools([...pi.getActiveTools(), "write", "Agent", "unknown_tool"]);
      });
    }`);
    const requests: ProviderContext[] = [];
    parent.worker.setResponses([
      request => { requests.push(request); return fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), { stopReason: "toolUse" }); },
      request => { requests.push(request); return fauxAssistantMessage("Filtered child result"); },
    ]);
    const task = await spawn(parent, "Read the file", false);
    expect(requests.map(request => request.tools?.map(tool => tool.name))).toEqual([["read"], ["read"]]);
    expect(requests[1].messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "read", isError: false,
      content: expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("Readable without UI") })]) }));
    expect(task.policy.tools).toEqual(["read", "ask_user_question"]);
    const ctx = parent.runtime.context;
    await parent.runtime.dispose();
    const replacement = new ExtensionRuntime(parent.api, { agentDir: parent.directory });
    harness.onDispose(() => replacement.dispose());
    await replacement.start(ctx);
    expect(replacement.engine.get(task.taskId).policy.tools).toEqual(task.policy.tools);
    parent.worker.setResponses([request => { requests.push(request); return fauxAssistantMessage("Restored filtered result"); }]);
    await replacement.engine.continue(task.taskId, { text: "Continue with the filtered tools" });
    await replacement.engine.wait(task.taskId);
    expect(requests.at(-1)!.tools?.map(tool => tool.name)).toEqual(["read"]);
    expect(warnings).not.toHaveBeenCalled();
    expect(parent.errors).toEqual([]);
  });

  it("reports child hook failures while preserving tool execution and durable delivery", async () => {
    const parent = await host("hook-errors", "tools: [read]\nextensions: [probe]\nskills: false");
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    mkdirSync(join(parent.directory, "extensions"));
    writeFileSync(join(parent.directory, "input.txt"), "Read after a hook failure");
    writeFileSync(join(parent.directory, "extensions", "probe.ts"), `export default function (pi) {
      pi.on("before_agent_start", () => { throw new Error("Optional startup hook failed"); });
      pi.on("tool_result", () => { throw new Error("Optional result hook failed"); });
    }`);
    const requests: ProviderContext[] = [];
    parent.worker.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), { stopReason: "toolUse" }),
      request => { requests.push(request); return fauxAssistantMessage("Result after child hook errors"); },
    ]);
    parent.parentProvider.setResponses([fauxAssistantMessage("Child result received")]);
    const task = await spawn(parent); await settled(parent.runtime, task.taskId);
    await parent.runtime.flushDeliveries(); await parent.session.waitForIdle();
    expect(requests[0].messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "read", isError: false }));
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("Optional startup hook failed"));
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("Optional result hook failed"));
    expect(resultEntries(parent)).toHaveLength(1);
    expect(readFileSync(parent.session.sessionManager.getSessionFile()!, "utf8")).toContain("Result after child hook errors");
    expect(parent.errors).toEqual([]);
  });

  it("keeps child state write failures fatal to tool execution and resource flushing", async () => {
    const parent = await host("write-error", "tools: [probe/inspect]\nextensions: [probe]\nskills: false");
    mkdirSync(join(parent.directory, "extensions"));
    writeFileSync(join(parent.directory, "extensions", "probe.ts"), `import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      export default function (pi) {
        pi.on("before_agent_start", () => pi.appendEntry("probe.state", { count: 1 }));
        pi.registerTool({ name: "inspect", label: "Inspect", description: "Record a tool effect", parameters: { type: "object", properties: {} },
          execute: async (_id, _args, _signal, _update, ctx) => {
            writeFileSync(join(ctx.cwd, "executed.txt"), "Tool executed");
            return { content: [{ type: "text", text: "Tool executed" }], details: {} };
          } });
      }`);
    const writeFailure = new Error("Child state persistence failed");
    const attach = PiResources.prototype.attach;
    vi.spyOn(PiResources.prototype, "attach").mockImplementation(async function (this: PiResources, childHarness, lane, store) {
      await attach.call(this, childHarness, lane, store);
      vi.spyOn(store.session, "setValue").mockRejectedValue(writeFailure);
    });
    const requests: ProviderContext[] = [];
    parent.worker.setResponses([
      fauxAssistantMessage(fauxToolCall("inspect", {}), { stopReason: "toolUse" }),
      request => { requests.push(request); return fauxAssistantMessage("Tool execution was blocked"); },
    ]);
    await spawn(parent, "Attempt the tool after saving state", false);
    expect(requests[0].messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "inspect", isError: true,
      content: expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining(writeFailure.message) })]) }));
    expect(existsSync(join(parent.directory, "executed.txt"))).toBe(false);
    await expect(parent.runtime.dispose()).rejects.toThrow("cleanup failed");
  });

  it("keeps Escape stops silent across reload and delivers preserved fragments only through selection", async () => {
    const parent = await host("user-stop"); const gate = holdRead();
    const fragment = "Partial findings before the user stopped execution";
    parent.worker.setResponses([fauxAssistantMessage([{ type: "text", text: fragment }, fauxToolCall("read", { path: "wait" })], { stopReason: "toolUse" })]);
    parent.parentProvider.setResponses([fauxAssistantMessage("Selected findings received")]);
    const sent = vi.spyOn(parent.api, "sendMessage");
    const parentCalls = parent.parentProvider.state.callCount;
    const parentFile = parent.session.sessionManager.getSessionFile()!;
    const parentLog = readFileSync(parentFile, "utf8");
    const task = await spawn(parent); await gate.entered.promise;
    await parent.runtime.source!.refresh();
    const stopUI = makeUI({ value: "" });
    const navigator = parent.runtime.navigator!;
    navigator.setUICtx(stopUI.ctx);
    const screen = mountSelector(stopUI);
    navigator.handleTerminalInput("\x1b[B"); navigator.handleTerminalInput("\x1b[B"); navigator.handleTerminalInput("\r");
    expect(navigator.selectedId()).toBe(task.taskId);
    const editor = screen.tui.children[screen.tui.editorIndex].children[0];
    const parentEscape = vi.fn(); editor.onEscape = parentEscape;
    const dispatched = vi.spyOn(parent.runtime.source!, "dispatch");
    const observed = vi.fn();
    const waiting = parent.runtime.engine.wait(task.taskId);
    void waiting.then(observed, () => { /* Runtime teardown can end an unfinished observation. */ });
    stopUI.baseEditor.onEscape?.();
    await dispatched.mock.results[0].value;
    expect(parentEscape).not.toHaveBeenCalled();
    expect(parent.runtime.engine.get(task.taskId)).toMatchObject({ control: "autonomous", state: { status: "cancelling" } });
    expect(observed).not.toHaveBeenCalled();
    gate.release.resolve(); await settled(parent.runtime, task.taskId);
    expect((await waiting).state).toMatchObject({ status: "settled", outcome: { status: "stopped", stoppedBy: "user" } });
    await parent.runtime.flushDeliveries(); await parent.session.waitForIdle();
    expect(parent.runtime.engine.get(task.taskId).state).toMatchObject({ status: "settled", outcome: { status: "stopped", stoppedBy: "user" } });
    expect(await parent.runtime.engine.storedDeliveries(task.taskId)).toEqual([]);
    expect(sent).not.toHaveBeenCalled();
    expect(parent.parentProvider.state.callCount).toBe(parentCalls);
    expect(readFileSync(parentFile, "utf8")).toBe(parentLog);
    const ctx = parent.runtime.context;
    await parent.runtime.dispose();
    const replacement = new ExtensionRuntime(parent.api, { agentDir: parent.directory });
    harness.onDispose(() => replacement.dispose());
    await replacement.start(ctx);
    expect(replacement.engine.get(task.taskId)).toMatchObject({ control: "autonomous", state: { status: "settled", outcome: { status: "stopped", stoppedBy: "user" } } });
    expect(replacement.source!.getRecord(task.taskId)?.canDeliver).toBe(true);
    expect(replacement.source!.getRecord(task.taskId)?.lifecycle.takenOver).toBe(false);
    expect(replacement.source!.transcript(task.taskId).messages).toContainEqual(expect.objectContaining({ role: "assistant", text: fragment }));
    expect(await replacement.engine.storedDeliveries(task.taskId)).toEqual([]);
    expect(sent).not.toHaveBeenCalled();
    expect(parent.parentProvider.state.callCount).toBe(parentCalls);
    expect(readFileSync(parentFile, "utf8")).toBe(parentLog);

    const modal = Promise.withResolvers<boolean>();
    let selector!: DeliverySelectorComponent;
    const selectUI = makeUI({ value: "" });
    replacement.navigator!.setUICtx({ ...selectUI.ctx, custom: (factory: any) => {
      selector = factory(makeTui(), selectUI.theme, undefined, (saved: boolean) => modal.resolve(saved));
      return modal.promise;
    } } as any);
    mountSelector(selectUI);
    replacement.navigator!.handleTerminalInput("\x1b[B"); replacement.navigator!.handleTerminalInput("\x1b[B");
    const opening = vi.spyOn(replacement.navigator!, "openDeliverySelector");
    expect(replacement.navigator!.handleTerminalInput("\x1bs")).toEqual({ consume: true });
    const selection = opening.mock.results[0].value;
    harness.onDispose(async () => { modal.resolve(false); await selection; });
    expect(selector.render(120).join("\n")).toContain(fragment);
    expect(sent).not.toHaveBeenCalled();
    selector.handleInput("\r"); await selection;
    await replacement.flushDeliveries(); await parent.session.waitForIdle();
    const deliveries = await replacement.engine.storedDeliveries(task.taskId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ delivery: { kind: "selection", status: "stopped", text: `[assistant]\n${fragment}` },
      receipt: { parentSessionId: parent.session.sessionManager.getSessionId() } });
    expect(resultEntries(parent)).toHaveLength(1);
    expect(parent.parentProvider.state.callCount).toBe(parentCalls + 1);
    parent.worker.setResponses([fauxAssistantMessage("Autonomous continuation result")]);
    parent.parentProvider.setResponses([fauxAssistantMessage("Continuation received")]);
    await replacement.engine.continue(task.taskId, { text: "Continue the task" });
    await replacement.engine.wait(task.taskId);
    await replacement.flushDeliveries(); await parent.session.waitForIdle();
    await replacement.source!.refresh();
    expect(replacement.engine.get(task.taskId)).toMatchObject({ control: "autonomous", state: { status: "settled", outcome: { status: "completed" } } });
    expect(replacement.source!.getRecord(task.taskId)?.canDeliver).toBe(false);
    expect((await replacement.engine.storedDeliveries(task.taskId)).map(stored => stored.delivery.kind).sort()).toEqual(["automatic", "selection"]);
    expect(resultEntries(parent)).toHaveLength(2);
    expect(parent.parentProvider.state.callCount).toBe(parentCalls + 2);
    expect(parent.errors).toEqual([]);
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
    await parent.runtime.flushDeliveries(); await parent.session.waitForIdle();
    expect((await parent.runtime.engine.storedDeliveries(task.taskId)).map(stored => stored.delivery.kind)).toEqual(["automatic"]);
    expect(resultEntries(parent)).toHaveLength(1);
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
