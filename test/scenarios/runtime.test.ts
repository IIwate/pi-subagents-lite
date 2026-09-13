import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ExtensionRuntime } from "../../src/runtime.js";
import { executeAgentTool, executeStopAgentTool } from "../../src/agents/tool-execution.js";
import { executeAgentStatusTool } from "../../src/agents/agent-status.js";
import { PiResources } from "../../src/drivers/pi-resources.js";
import type { DeliverySelectorComponent } from "../../src/ui/delivery-selector.js";
import { createTestHarness, type TestHarness } from "../support/harness.js";
import { createRuntimeHost, holdRead, resultEntries, settled, spawn } from "../support/runtime.js";
import { makeTui, makeUI, mountSelector } from "../support/navigator.js";

describe("ExtensionRuntime ownership", () => {
  let harness: TestHarness;
  beforeEach(() => { harness = createTestHarness(); });
  afterEach(() => harness.dispose());

  it("runs the registered Agent tool on the official parent and durably delivers its native result", async () => {
    const parent = await createRuntimeHost(harness, "entry");
    const requests: string[] = [];
    parent.worker.setResponses([request => { requests.push(JSON.stringify(request)); return fauxAssistantMessage("Native child result"); }]);
    parent.parentProvider.setResponses([
      fauxAssistantMessage(fauxToolCall("Agent", { agent: "worker", prompt: "Work independently", model: "entry-worker/child", run_in_background: true }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Delegated"), fauxAssistantMessage("Result consumed"),
    ]);
    await parent.session.prompt("Delegate a task");
    const task = parent.runtime.engine.list()[0];
    expect(task).toBeDefined();
    await settled(harness, parent.runtime, task.taskId);
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
    const parent = await createRuntimeHost(harness, "mode"); const gate = holdRead(harness);
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
    gate.release.resolve(); await settled(harness, parent.runtime, task.taskId);
    expect(parent.runtime.engine.get(task.taskId).state).toMatchObject({ status: "settled", outcome: { status: "completed", result: "Configured mode result" } });
    if (mode === "foreground") expect((await execution).content[0].text).toContain("Configured mode result");
    await parent.runtime.flushDeliveries(); await parent.session.waitForIdle();
    expect(resultEntries(parent)).toHaveLength(mode === "background" ? 1 : 0);
    if (mode === "background") expect(readFileSync(parent.session.sessionManager.getSessionFile()!, "utf8")).toContain("Configured mode result");
    expect(parent.errors).toEqual([]);
  });

  it("refreshes background guidance on the next parent turn and preserves identical effective prompts", async () => {
    const parent = await createRuntimeHost(harness, "guidance");
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
    const first = await createRuntimeHost(harness, "first"); const second = await createRuntimeHost(harness, "second");
    const gate = holdRead(harness);
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
    const other = await spawn(second); await settled(harness, second.runtime, other.taskId);
    const closing = first.runtime.dispose();
    expect(() => first.runtime.store.mutate.agent.setGraceTurns(2)).toThrow("closed runtime");
    gate.release.resolve(); await closing;
    expect(second.runtime.engine.get(other.taskId).state).toMatchObject({ status: "settled", outcome: { result: "Second done" } });
    expect(second.runtime.active).toBe(true);
    expect(resultEntries(first)).toHaveLength(0);
    expect(running.taskId).not.toBe(other.taskId);
  });

  it("discovers accepted operations from native files after reload and resumes only through explicit input", async () => {
    const parent = await createRuntimeHost(harness, "reload");
    const gate = holdRead(harness);
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
    await settled(harness, replacement, queued.taskId);
    const status = await executeAgentStatusTool(replacement, "status", { agent_id: queued.taskId }, undefined, undefined, replacement.context);
    expect(status.content[0].text).toContain("Resumed report");
    expect(replacement.engine.get(queued.taskId).operationId).toBe(queued.operationId);
  });

  it("hides expired native tasks on reload while preserving their saved results", async () => {
    const parent = await createRuntimeHost(harness, "expired");
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
    const parent = await createRuntimeHost(harness, "late");
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
    const parent = await createRuntimeHost(harness, "control"); const gate = holdRead(harness);
    parent.worker.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "wait" }), { stopReason: "toolUse" }), fauxAssistantMessage("Manual final result")]);
    const foreground = executeAgentTool(parent.runtime, "foreground", { agent: "worker", prompt: "Work", model: "control-worker/child" }, undefined, undefined, parent.runtime.context);
    await gate.entered.promise;
    const task = parent.runtime.engine.list()[0];
    await parent.runtime.engine.queue(task.taskId, "steer", { text: "Refine the result" });
    expect(parent.runtime.engine.get(task.taskId).control).toBe("autonomous");
    await parent.runtime.engine.takeOver(task.taskId);
    expect((await foreground).content[0].text).toContain("User took over");
    gate.release.resolve(); await settled(harness, parent.runtime, task.taskId);
    await parent.runtime.flushDeliveries();
    expect(resultEntries(parent)).toEqual([]);
    const stop = await executeStopAgentTool(parent.runtime, "stop", { agent_id: task.taskId }, undefined, undefined, parent.runtime.context);
    expect(stop.content[0].text).toContain("already completed");
  });

  it("keeps Escape stops silent across reload and delivers preserved fragments only through selection", async () => {
    const parent = await createRuntimeHost(harness, "user-stop"); const gate = holdRead(harness);
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
    gate.release.resolve(); await settled(harness, parent.runtime, task.taskId);
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
    expect(deliveries[0]).toMatchObject({ delivery: { kind: "selection", status: "stopped" },
      receipt: { parentSessionId: parent.session.sessionManager.getSessionId() } });
    expect(deliveries[0].delivery.text.split(/\r?\n/)).toEqual(["[assistant]", fragment]);
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
    const parent = await createRuntimeHost(harness, "stop"); const gate = holdRead(harness);
    parent.worker.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "wait" }), { stopReason: "toolUse" })]);
    parent.parentProvider.setResponses([fauxAssistantMessage("Stopped result received")]);
    const task = await spawn(parent); await gate.entered.promise;
    await executeStopAgentTool(parent.runtime, "stop", { agent_id: task.taskId }, undefined, undefined, parent.runtime.context);
    expect(parent.runtime.engine.get(task.taskId).state.status).toBe("cancelling");
    gate.release.resolve(); await settled(harness, parent.runtime, task.taskId);
    expect(parent.runtime.engine.get(task.taskId).state).toMatchObject({ status: "settled", outcome: { status: "stopped", stoppedBy: "agent" } });
    await parent.runtime.flushDeliveries(); await parent.session.waitForIdle();
    expect((await parent.runtime.engine.storedDeliveries(task.taskId)).map(stored => stored.delivery.kind)).toEqual(["automatic"]);
    expect(resultEntries(parent)).toHaveLength(1);
  });

  it("continues after a provider failure and delivers the current operation result", async () => {
    const parent = await createRuntimeHost(harness, "recovery");
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
