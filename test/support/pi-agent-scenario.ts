import { vi } from "vitest";
import { InMemoryCredentialStore, InMemoryModelsStore, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime, type createAgentSession, type DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { createAgentScenario } from "./agent-scenario.js";
import { createDefaultConfig } from "./harness.js";

const runtime = vi.hoisted(() => ({
  agentDir: "",
  models: undefined as unknown as ModelRuntime,
  loaderOptions: [] as ConstructorParameters<typeof DefaultResourceLoader>[0][],
  sessions: [] as Awaited<ReturnType<typeof createAgentSession>>["session"][],
  preloadCalls: [] as string[][],
  skillMetaCalls: [] as string[][],
  createAgentSession: vi.fn<typeof createAgentSession>(),
}));

// Pi owns the agent loop and retries; fixture settings only shorten backoff.
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  runtime.createAgentSession.mockImplementation(async options => {
    const result = await actual.createAgentSession({
      ...options, modelRuntime: runtime.models,
      settingsManager: actual.SettingsManager.inMemory({
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 }, compaction: { enabled: false },
      }),
    });
    runtime.sessions.push(result.session);
    return result;
  });
  return {
    ...actual,
    createAgentSession: runtime.createAgentSession,
    getAgentDir: () => runtime.agentDir,
    DefaultResourceLoader: class extends actual.DefaultResourceLoader {
      constructor(options: ConstructorParameters<typeof DefaultResourceLoader>[0]) {
        super(options);
        runtime.loaderOptions.push(options);
      }
    },
  };
});

vi.mock("../../src/prompt/skill-loader.js", () => ({
  preloadSkills: vi.fn((names: string[]) => { runtime.preloadCalls.push([...names]); return []; }),
  loadSkillMeta: vi.fn((names: string[]) => { runtime.skillMetaCalls.push([...names]); return []; }),
}));

export async function createPiAgentScenario() {
  const scenario = createAgentScenario({ initialConfig: createDefaultConfig({
    modelRouting: {
      enabled: true, enabledProviders: ["other"],
      agentAccess: { "general-purpose": { providers: { other: {} } } },
    },
    agent: { forceBackground: false, graceTurns: 2, includeContextFiles: false },
    concurrency: { default: 1 },
  }) });
  runtime.agentDir = scenario.directory;
  runtime.loaderOptions = [];
  runtime.sessions = [];
  runtime.preloadCalls = [];
  runtime.skillMetaCalls = [];
  runtime.createAgentSession.mockClear();
  runtime.models = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, refreshOnCreate: false,
  });
  const providers = [
    fauxProvider({ provider: "parent", api: `parent-${scenario.sessionId}`, tokensPerSecond: 100000,
      models: [{ id: "main-model", reasoning: true }, { id: "next-model", reasoning: true }] }),
    fauxProvider({ provider: "other", api: `other-${scenario.sessionId}`, tokensPerSecond: 100000,
      models: [{ id: "worker-model", reasoning: true }] }),
  ];
  const first = Promise.withResolvers<void>();
  let firstStarted = false;
  for (const provider of providers) {
    runtime.models.registerNativeProvider(provider.provider);
    provider.setResponses([
      async (_context, options) => {
        if (!firstStarted) {
          firstStarted = true;
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
  const models = providers.flatMap(provider => provider.models);
  scenario.ctx.model = { ...models[0] };
  scenario.ctx.modelRegistry = {
    find: vi.fn((provider: string, id: string) => models.find(model => model.provider === provider && model.id === id)),
    getAll: vi.fn(() => models), getAvailable: vi.fn(() => models),
  };
  scenario.ctx.scopedModels = [{ model: models[0] }, { model: models[2], thinkingLevel: "high" }];
  scenario.ctx.getSystemPrompt = () => "Parent prompt";
  scenario.onDispose(() => first.resolve());
  return {
    ...scenario, providers, releaseFirst: first.resolve,
    loaderOptions: runtime.loaderOptions, sessions: runtime.sessions,
    preloadCalls: runtime.preloadCalls, skillMetaCalls: runtime.skillMetaCalls,
    createAgentSession: runtime.createAgentSession,
  };
}

export type PiAgentScenario = Awaited<ReturnType<typeof createPiAgentScenario>>;
