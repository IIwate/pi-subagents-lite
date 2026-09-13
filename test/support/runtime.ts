import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ExtensionRuntime } from "../../src/runtime.js";
import { registerTools } from "../../src/registration.js";
import { setupEventListeners } from "../../src/events.js";
import { executeAgentTool } from "../../src/agents/tool-execution.js";
import { PiResources } from "../../src/drivers/pi-resources.js";
import { RESULT_MESSAGE_TYPE } from "../../src/drivers/pi-delivery-channel.js";
import type { TestHarness } from "./harness.js";

export async function createRuntimeHost(harness: TestHarness, name: string, agentBody = "tools: [read]\nextensions: false\nskills: false", cwd?: string) {
  const directory = harness.createTempDir(`pi-runtime-${name}-`);
  cwd ??= directory;
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
  const loader = new DefaultResourceLoader({ cwd, agentDir: directory, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => {
      api = pi; runtime = new ExtensionRuntime(pi, { agentDir: directory });
      registerTools(pi, runtime); setupEventListeners(pi, runtime);
    }],
  });
  await loader.reload();
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const { session } = await createAgentSession({ cwd, agentDir: directory, modelRuntime: models,
    model: parentProvider.getModel(), sessionManager: SessionManager.create(cwd, join(directory, "parent")),
    settingsManager: settings, resourceLoader: loader });
  harness.onDispose(async () => { await session.abort(); session.dispose(); await settings.flush(); });
  harness.onDispose(async () => { if (runtime.active) await runtime.dispose(); });
  await session.bindExtensions({ onError: error => errors.push(error.error) });
  parentProvider.setResponses([fauxAssistantMessage("Parent ready")]);
  await session.prompt("Parent private context");
  runtime.store.mutate.routing.configureAgentProviderAccess("worker", worker.provider.id);
  return { directory, runtime, session, parentProvider, worker, errors, api };
}

type Host = Awaited<ReturnType<typeof createRuntimeHost>>;
export async function spawn(parent: Host, text = "Delegated task", background = true) {
  await executeAgentTool(parent.runtime, "call", { agent: "worker", prompt: text, model: `${parent.worker.provider.id}/child`,
    run_in_background: background }, undefined, undefined, parent.runtime.context);
  return parent.runtime.engine.list().at(-1)!;
}
export function settled(harness: TestHarness, runtime: ExtensionRuntime, id: string): Promise<void> {
  const done = Promise.withResolvers<void>();
  const check = () => { if (runtime.engine.get(id).state.status === "settled") done.resolve(); };
  const stop = runtime.engine.subscribe(check); harness.onDispose(stop);
  check(); return done.promise.finally(stop);
}
export function resultEntries(parent: Host) {
  return parent.session.sessionManager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === RESULT_MESSAGE_TYPE);
}
export function holdRead(harness: TestHarness) {
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
