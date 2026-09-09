import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore, InMemoryModelsStore, fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type AgentSessionEvent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { continueAgentSession } from "../../../src/agents/agent-runner.js";
import { createTestHarness, type TestHarness } from "../../support/harness.js";
import { makeResolvablePromise } from "../../support/fixtures.js";

describe("Pi session integration", () => {
  let harness: TestHarness;
  let provider: ReturnType<typeof fauxProvider>;
  let events: AgentSessionEvent[];

  beforeEach(() => {
    harness = createTestHarness();
    provider = fauxProvider({ provider: `test-${harness.sessionId}`, tokensPerSecond: 100000 });
    events = [];
  });
  afterEach(async () => { await harness.dispose(); });

  async function createSession(customTools: ToolDefinition[] = []): Promise<AgentSession> {
    const cwd = harness.createTempDir();
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(provider.provider);
    const settings = SettingsManager.inMemory({
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
      compaction: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd, agentDir: cwd,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd, agentDir: cwd, modelRuntime: runtime, model: provider.getModel(),
      sessionManager: SessionManager.create(cwd, cwd), settingsManager: settings,
      resourceLoader: loader, tools: customTools.map(tool => tool.name), customTools,
    });
    await session.bindExtensions({});
    const unsubscribe = session.subscribe(event => events.push(event));
    harness.onDispose(async () => {
      unsubscribe();
      await session.abort();
      session.dispose();
      await settings.flush();
    });
    return session;
  }

  it.each([
    "stream disconnected before completion",
    "stream closed before response.completed",
    "invalid SSE data JSON: truncated payload",
    "stream_read_error: upstream closed the response",
    "upstream_error",
    "Upstream request failed",
    "request failed: EOF",
  ])("retries a transport failure through Pi's actual agent loop: %s", async errorMessage => {
    provider.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage }),
      fauxAssistantMessage("Recovered result"),
    ]);
    const session = await createSession();
    const result = await continueAgentSession(session, "Run the task");
    expect(result.responseText).toBe("Recovered result");
    expect(provider.state.callCount).toBe(2);
    expect(events.filter(event => event.type === "auto_retry_start")).toHaveLength(1);
    expect(events.filter(event => event.type === "agent_settled")).toHaveLength(1);
    expect(session.isIdle).toBe(true);
    expect(session.sessionManager.getEntries().some(entry => entry.type === "message"
      && entry.message.role === "assistant"
      && entry.message.content.some(block => block.type === "text" && block.text === "Recovered result"))).toBe(true);
  });

  it.each([
    { content: [] },
    { content: [fauxThinking("Working")] },
    { content: [{ type: "text" as const, text: "  \n " }] },
  ])("retries a blank response and returns the next completed response: $content", async ({ content }) => {
    provider.setResponses([
      fauxAssistantMessage(content),
      fauxAssistantMessage([{ type: "text" as const, text: "Completed" }]),
    ]);
    const result = await continueAgentSession(await createSession(), "Run the task");
    expect(result.responseText).toBe("Completed");
    expect(provider.state.callCount).toBe(2);
  });

  it("preserves Pi's existing retry classification", async () => {
    provider.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
      fauxAssistantMessage("Completed"),
    ]);
    expect((await continueAgentSession(await createSession(), "Run the task")).responseText).toBe("Completed");
    expect(provider.state.callCount).toBe(2);
  });

  it("returns a permanent provider error without requesting a replacement result", async () => {
    provider.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid api key" })]);
    await expect(continueAgentSession(await createSession(), "Run the task")).rejects.toThrow("invalid api key");
    expect(provider.state.callCount).toBe(1);
    expect(events.some(event => event.type === "auto_retry_start")).toBe(false);
  });

  it("executes a native tool turn before collecting the final result", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Tool output" }], details: {} }));
    provider.setResponses([
      fauxAssistantMessage([fauxToolCall("report", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("Final report"),
    ]);
    const session = await createSession([{
      name: "report", label: "Report", description: "Return the report", parameters: Type.Object({}), execute,
    }]);
    const result = await continueAgentSession(session, "Run the task");
    expect(result.responseText).toBe("Final report");
    expect(execute).toHaveBeenCalledOnce();
    expect(session.messages.some(message => message.role === "toolResult" && message.toolName === "report")).toBe(true);
    expect(events.filter(event => event.type === "agent_settled")).toHaveLength(1);
  });

  it("settles a native abort without retrying the interrupted request", async () => {
    const started = makeResolvablePromise();
    provider.setResponses([async (_context, options) => {
      started.resolve(undefined);
      await new Promise<void>(resolve => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }]);
    const session = await createSession();
    const running = continueAgentSession(session, "Run the task");
    await started.promise;
    await session.abort();
    expect((await running).aborted).toBe(true);
    expect(provider.state.callCount).toBe(1);
    expect(session.isIdle).toBe(true);
  });
});
