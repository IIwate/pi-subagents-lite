import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { KeybindingsManager } from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore, type Context as ProviderContext } from "@earendil-works/pi-ai";
import { HarnessDriver, type HarnessDriverOptions } from "../../../src/drivers/harness-driver.js";
import { TaskEngine } from "../../../src/engine/task-engine.js";
import { AgentNavigator } from "../../../src/ui/agent-navigator.js";
import { DeliverySelectorComponent } from "../../../src/ui/delivery-selector.js";
import { TaskNavigationSource } from "../../../src/ui/task-source.js";
import { createTestHarness, type TestHarness } from "../../support/harness.js";
import { makeTui, makeUI, mountSelector } from "../../support/navigator.js";

describe("Native task navigation", () => {
  let resources: TestHarness;
  beforeEach(() => { resources = createTestHarness(); });
  afterEach(() => resources.dispose());

  async function scene(provider: ReturnType<typeof fauxProvider>, tools: HarnessDriverOptions["tools"] = [], release?: () => void) {
    const directory = resources.createTempDir("pi-task-navigation-");
    const models = createModels({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore() });
    models.setProvider(provider.provider);
    const session = await new MemorySessionRepo().create({ parentSessionId: "parent" }, BACKGROUND_CONTEXT);
    const driver = await HarnessDriver.open({ session, models, tools,
      binding: { taskId: "worker", parent: { sessionId: "parent", entryId: "origin" }, mode: "foreground", control: "autonomous",
        policy: { agent: "Worker", model: { provider: provider.provider.id, id: provider.getModel().id }, thinkingLevel: "off",
          tools: tools?.map(tool => tool.name) ?? [], cwd: directory, systemPrompt: "Offline worker", limits: { graceTurns: 1 } } },
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1000 },
    });
    resources.onDispose(() => driver.close());
    const engine = new TaskEngine({ default: 1 }, { deliver: async () => ({ status: "pending", reason: "busy" }) });
    resources.onDispose(() => engine.close());
    const source = new TaskNavigationSource(engine);
    const navigator = new AgentNavigator(source);
    resources.onDispose(() => navigator.dispose());
    if (release) resources.onDispose(release);
    const ui = makeUI({ value: "" });
    navigator.setUICtx(ui.ctx);
    await engine.accept(driver, { text: "Work on the report" });
    await changed(source, () => Boolean(source.getRecord("worker")));
    const fixture = mountSelector(ui, makeTui(), new KeybindingsManager({
      "app.message.followUp": { defaultKeys: "ctrl+q" }, "app.message.dequeue": { defaultKeys: "alt+q" },
    }));
    navigator.handleTerminalInput("\x1b[B"); navigator.handleTerminalInput("\x1b[B"); navigator.handleTerminalInput("\r");
    return { driver, engine, source, navigator, ui, fixture };
  }

  async function changed(source: TaskNavigationSource, predicate: () => boolean): Promise<void> {
    const done = Promise.withResolvers<void>();
    const check = () => { if (predicate()) done.resolve(); };
    const unsubscribe = source.subscribe(check);
    resources.onDispose(unsubscribe);
    check(); await done.promise; unsubscribe();
  }

  async function settled(engine: TaskEngine): Promise<void> {
    const done = Promise.withResolvers<void>();
    const check = () => { if (engine.get("worker").state.status === "settled") done.resolve(); };
    const unsubscribe = engine.subscribe(check);
    resources.onDispose(unsubscribe);
    check(); await done.promise; unsubscribe();
  }

  it("routes Enter and FollowUp to native queues and takes over only through Alt+T", async () => {
    const provider = fauxProvider({ provider: "ui-worker", api: "ui-worker", tokensPerSecond: 100000 });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const requests: ProviderContext[] = [];
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
      request => { requests.push(request); return fauxAssistantMessage("Steered report"); },
      request => { requests.push(request); return fauxAssistantMessage("Final report\x07"); },
    ]);
    const state = await scene(provider, [{ name: "probe", label: "Probe", description: "Hold a task checkpoint.", parameters: Type.Object({}), replay: "never",
      execute: async () => { entered.resolve(); await release.promise; return { content: [{ type: "text", text: "Done" }], details: {} }; } }], release.resolve);
    await entered.promise;
    const editor = state.fixture.tui.children[state.fixture.tui.editorIndex].children[0];
    const parentSubmit = vi.fn();
    editor.onSubmit = parentSubmit;
    state.ui.baseEditor.setText("Keep the report concise");
    editor.handleInput("\r");
    editor.actionHandlers.set("app.message.followUp", parentSubmit);
    state.ui.baseEditor.setText("Add a final recommendation");
    editor.handleInput("\x11");
    await changed(state.source, () => state.source.getRecord("worker")?.queued.length === 2);
    expect(state.source.getRecord("worker")?.queued.map(item => item.kind)).toEqual(["steer", "followUp"]);
    expect(state.engine.get("worker").control).toBe("autonomous");
    expect(parentSubmit).not.toHaveBeenCalled();
    const foreground = state.engine.wait("worker");
    expect(state.navigator.handleTerminalInput("\x1bt")).toEqual({ consume: true });
    expect((await foreground).state.status).toBe("running");
    expect(state.engine.get("worker").control).toBe("manual");
    release.resolve();
    await settled(state.engine);
    await changed(state.source, () => state.source.getRecord("worker")?.execution.settled === true);
    expect(JSON.stringify(requests[0].messages)).toContain("Keep the report concise");
    expect(JSON.stringify(requests[1].messages)).toContain("Add a final recommendation");
    const text = state.fixture.tui.document.children[state.fixture.tui.chatIndex].render(80).join("\n");
    expect(text).toContain("Final report");
    expect(text).not.toContain("\x07");
    expect(await state.driver.store.deliveries()).toEqual([]);
  });

  it("retries the same selection after a lost save response and a later operation", async () => {
    const provider = fauxProvider({ provider: "selection-worker", api: "selection-worker", tokensPerSecond: 100000 });
    const original = "Original selected report\x07";
    provider.setResponses([fauxAssistantMessage(original), fauxAssistantMessage("", { stopReason: "error", errorMessage: "Later operation failed" })]);
    const state = await scene(provider);
    await settled(state.engine);
    await state.engine.takeOver("worker");
    await changed(state.source, () => state.source.getRecord("worker")?.canDeliver === true);
    const operationId = state.engine.get("worker").operationId;
    const modal = Promise.withResolvers<boolean>();
    let selector!: DeliverySelectorComponent;
    const custom = vi.fn((factory: any) => {
      selector = factory(makeTui(), state.ui.theme, undefined, (saved: boolean) => modal.resolve(saved));
      return modal.promise;
    });
    state.navigator.setUICtx({ ...state.ui.ctx, custom } as any);
    state.navigator.handleTerminalInput("\x1b[B"); state.navigator.handleTerminalInput("\x1b[B");
    const opening = state.navigator.openDeliverySelector();
    resources.onDispose(async () => { modal.resolve(false); await opening; });
    expect(selector.render(80).join("\n")).toContain("Original selected report");
    expect(selector.render(80).join("\n")).not.toContain("\x07");
    const saved = state.driver.store.saveDelivery.bind(state.driver.store);
    vi.spyOn(state.driver.store, "saveDelivery").mockImplementationOnce(async delivery => {
      await saved(delivery); throw new Error("Native commit response lost");
    });
    const notice = Promise.withResolvers<void>();
    const setNotice = selector.setNotice.bind(selector);
    vi.spyOn(selector, "setNotice").mockImplementation((text, locked) => { setNotice(text, locked); notice.resolve(); });
    selector.handleInput("\r");
    await notice.promise;
    const first = (await state.driver.store.deliveries())[0].delivery;
    expect(selector.render(80).join("\n")).toContain("Save failed");
    await state.engine.continue("worker", { text: "Continue after the selected report" });
    await settled(state.engine);
    await state.source.refresh();
    selector.handleInput("\r");
    await opening;
    const deliveries = await state.driver.store.deliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].delivery).toEqual(first);
    expect(deliveries[0].delivery).toMatchObject({ operationId, status: "completed", text: expect.stringContaining(original) });
    expect(deliveries[0].delivery.text).not.toContain("Later operation failed");
  });
});
