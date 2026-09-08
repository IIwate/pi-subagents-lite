import { afterEach, beforeEach, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, ExtensionContext, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { AcceptedRunPolicy } from "../../../src/types.js";
import { createTestHarness, type TestHarness } from "../../harness.js";
import { fakeCtx, fakePi } from "../../fixtures.js";

type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

const _runner = vi.hoisted(() => ({
  createSession: vi.fn(),
  prompt: vi.fn((..._args: unknown[]) => "System prompt"),
  contextFiles: vi.fn(() => [] as Array<{ path: string; content: string }>),
  preloadSkills: vi.fn(() => []),
  skillMeta: vi.fn(() => []),
  loaderOptions: [] as DefaultResourceLoaderOptions[],
  extensions: [] as Array<{ path: string; tools: Map<string, unknown> }>,
  agentDir: "",
  bashAvailable: true,
}));
export const runner = _runner;

vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: _runner.createSession,
    getAgentDir: () => _runner.agentDir,
    loadProjectContextFiles: _runner.contextFiles,
    DefaultResourceLoader: class {
      constructor(options: DefaultResourceLoaderOptions) { _runner.loaderOptions.push(options); }
      async reload() {}
      getExtensions() { return { extensions: _runner.extensions }; }
    },
  };
});
vi.mock("../../../src/agents/agent-types.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../../src/agents/agent-types.js")>(),
  isBashAvailable: () => _runner.bashAvailable,
}));
vi.mock("../../../src/prompt/prompts.js", () => ({ buildAgentPrompt: _runner.prompt }));
vi.mock("../../../src/prompt/skill-loader.js", () => ({ preloadSkills: _runner.preloadSkills, loadSkillMeta: _runner.skillMeta }));
vi.mock("../../../src/shell.js", () => ({ withSubagentSpawn: <T>(operation: () => Promise<T>) => operation() }));

import { runAgent as execute } from "../../../src/agents/agent-runner.js";

export function policy(overrides: Partial<AcceptedRunPolicy> = {}): AcceptedRunPolicy {
  return {
    definition: { name: "test-agent", description: "Test agent", systemPrompt: "Instructions" },
    registeredTools: ["read", "bash", "edit"],
    restrictToRegisteredTools: false,
    tools: true,
    extensions: true,
    skills: true,
    systemPromptMode: "replace",
    includeContextFiles: true,
    parentModelKey: "test/model",
    ...overrides,
  };
}

export function message(content: AssistantMessage["content"] = [{ type: "text", text: "Done" }], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant", content, stopReason: "stop", timestamp: 1,
    api: "test", provider: "test", model: "model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...overrides,
  };
}

export function createMockSession(content = message().content) {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const emit = (event: AgentSessionEvent) => { for (const listener of [...listeners]) listener(event); };
  return {
    emit,
    subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
    setSessionName: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read", "bash", "edit"]),
    getAllTools: vi.fn(() => ["read", "bash", "edit"].map(name => ({ name }))),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
    prompt: vi.fn(async (_text: string, _options?: unknown) => { emit({ type: "message_end", message: message(content) }); }),
    steer: vi.fn(async (_text: string, _images?: unknown) => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    messages: [] as AgentSession["messages"],
  };
}

// Unit fixtures expose only the public session methods consumed by the runner.
export function asSession(session: ReturnType<typeof createMockSession>): AgentSession {
  return session as unknown as AgentSession;
}

let harness: TestHarness;
export let ctx: ReturnType<typeof fakeCtx>;
export let pi: ReturnType<typeof fakePi>;
export let session: ReturnType<typeof createMockSession>;

beforeEach(() => {
  harness = createTestHarness();
  runner.agentDir = harness.createTempDir();
  runner.loaderOptions = [];
  runner.extensions = [];
  runner.bashAvailable = true;
  runner.createSession.mockReset();
  runner.prompt.mockReset();
  runner.contextFiles.mockReset();
  runner.preloadSkills.mockReset();
  runner.skillMeta.mockReset();
  ctx = fakeCtx();
  ctx.cwd = runner.agentDir;
  pi = fakePi();
  session = createMockSession();
  runner.createSession.mockResolvedValue({ session: asSession(session), extensionsResult: {} });
  harness.onDispose(() => session.dispose());
});
afterEach(async () => { await harness.dispose(); });

export function run(options: Partial<Parameters<typeof execute>[3]> = {}, context: ExtensionContext = ctx) {
  return execute(context, "test-agent", "Run the task", { pi, acceptedPolicy: policy(), ...options });
}
