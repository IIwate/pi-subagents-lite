/**
 * agent-runner.test.ts — Tests for the agent execution engine.
 *
 * Tests focus on:
 *   - isolated parameter handling (overrides extensions/skills)
 *   - tool filtering (excluded tools, whitelist, blacklist)
 *   - No inheritContext or memory code paths
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { fakeCtx, fakePi as makeFakePi, makeResolvablePromise } from "../fixtures.ts";

const fakePi = makeFakePi();

// --- Mock module-level dependencies ---

const _loaderOpts: any[] = [];
const _loaderGetExtensionsResult: any = { extensions: [], errors: [], runtime: {} };

// DefaultResourceLoader must be a regular function (not arrow) to support `new`
function MockDefaultResourceLoader(this: any, opts: any) {
  this._opts = opts;
  this.reload = vi.fn().mockResolvedValue(undefined);
  this.getExtensions = vi.fn().mockReturnValue(_loaderGetExtensionsResult);
  _loaderOpts.push(opts);
}

const mockModules = vi.hoisted(() => ({
  mockGetConfig: vi.fn(),
  mockGetAgentConfig: vi.fn(),
  mockGetToolNamesForType: vi.fn(),
  mockBuildAgentPrompt: vi.fn(),
  mockExtractText: vi.fn(),
  mockPreloadSkills: vi.fn().mockReturnValue([]),
  mockLoadSkillMeta: vi.fn().mockReturnValue([]),
  mockCreateAgentSession: vi.fn(),
  mockSessionManagerInMemory: vi.fn(),
  mockDefaultResourceLoader: MockDefaultResourceLoader,
  mockGetAgentDir: vi.fn(),
  mockLoadProjectContextFiles: vi.fn().mockReturnValue([]),
  mockIncludeContextFiles: true as boolean,
  mockSystemPromptMode: "replace" as string,
  mockDefaultThinking: undefined as string | undefined,
  getLoaderOpts: () => _loaderOpts[_loaderOpts.length - 1] ?? null,
  clearLoaderOpts: () => { _loaderOpts.length = 0; },
  setLoaderExtensions: (exts: any) => { _loaderGetExtensionsResult.extensions = exts; },
  clearLoaderExtensions: () => { _loaderGetExtensionsResult.extensions = []; },
  mockWithSubagentSpawn: vi.fn((operation: () => Promise<unknown>) => operation()),
}));

vi.mock("../../src/agents/agent-types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agents/agent-types.js")>();
  return {
    ...actual,
    getConfig: mockModules.mockGetConfig,
    getAgentConfig: mockModules.mockGetAgentConfig,
    getToolNamesForType: mockModules.mockGetToolNamesForType,
  };
});

vi.mock("../../src/prompt/prompts.js", () => ({
  buildAgentPrompt: mockModules.mockBuildAgentPrompt,
}));

vi.mock("../../src/prompt/context.js", () => ({
  extractText: mockModules.mockExtractText,
}));

vi.mock("../../src/prompt/skill-loader.js", () => ({
  preloadSkills: mockModules.mockPreloadSkills,
  loadSkillMeta: mockModules.mockLoadSkillMeta,
}));

vi.mock("../../src/shell.js", () => ({
  getStore: () => ({
    agent: {
      includeContextFiles: mockModules.mockIncludeContextFiles,
      systemPromptMode: mockModules.mockSystemPromptMode,
      graceTurns: 6,
      forceBackground: false,
      showCost: false,
      defaultThinking: mockModules.mockDefaultThinking,
    },
  }),
  withSubagentSpawn: mockModules.mockWithSubagentSpawn,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: mockModules.mockCreateAgentSession,
  DefaultResourceLoader: mockModules.mockDefaultResourceLoader,
  SessionManager: { inMemory: mockModules.mockSessionManagerInMemory },
  SettingsManager: { create: vi.fn() },
  getAgentDir: mockModules.mockGetAgentDir,
  loadProjectContextFiles: mockModules.mockLoadProjectContextFiles,
}));

// --- Import the module under test ---

import { continueAgentSession, runAgent as runAgentWithPolicy, subscribeToSessionEvents } from "../../src/agents/agent-runner.js";

const defaultConfig = {
  displayName: "Agent",
  description: "Test agent",
  registeredTools: ["read", "bash", "edit"],
  extensions: true,
  skills: true,
};

const defaultAgentConfig = {
  name: "test-agent",
  description: "Test agent",
  extensions: true,
  skills: true,
  systemPrompt: "You are a test agent.",
  tools: undefined as (true | string[] | false | undefined),
};

function runAgent(ctx: any, type: string, prompt: string, options: any) {
  const definition = structuredClone(mockModules.mockGetAgentConfig() ?? defaultAgentConfig);
  const config = mockModules.mockGetConfig();
  return runAgentWithPolicy(ctx, type, prompt, {
    ...options,
    acceptedPolicy: {
      definition,
      registeredTools: [...mockModules.mockGetToolNamesForType(type)],
      restrictToRegisteredTools: Boolean(definition.registeredTools?.length),
      tools: Array.isArray(definition.tools) ? [...definition.tools] : definition.tools,
      extensions: Array.isArray(config.extensions) ? [...config.extensions] : config.extensions,
      skills: Array.isArray(config.skills) ? [...config.skills] : config.skills,
      systemPromptMode: mockModules.mockSystemPromptMode,
      includeContextFiles: mockModules.mockIncludeContextFiles,
      parentModelKey: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "",
    },
  });
}

/**
 * Reset all mocks to their default state.
 */
function resetMocks() {
  vi.clearAllMocks();
  mockModules.clearLoaderOpts();
  mockModules.clearLoaderExtensions();
  mockModules.mockIncludeContextFiles = true;
  mockModules.mockSystemPromptMode = "replace";
  mockModules.mockDefaultThinking = undefined;
  mockModules.mockLoadProjectContextFiles.mockReturnValue([]);

  mockModules.mockGetConfig.mockReturnValue({ ...defaultConfig });
  mockModules.mockGetAgentConfig.mockReturnValue({ ...defaultAgentConfig });
  mockModules.mockGetToolNamesForType.mockReturnValue(["read", "bash", "edit"]);
  mockModules.mockBuildAgentPrompt.mockReturnValue("system prompt");
  mockModules.mockExtractText.mockImplementation((content: any) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((item: any) => item?.type === "text")
      .map((item: any) => item.text)
      .join("");
  });
  mockModules.mockSessionManagerInMemory.mockReturnValue(undefined);
  mockModules.mockGetAgentDir.mockReturnValue("/home/test/.pi/agent");
  mockModules.mockPreloadSkills.mockReturnValue([]);
}

/**
 * Create a mock session with default stubs.
 */
function createMockSession() {
  const listeners: Array<(event: any) => void> = [];
  return {
    setSessionName: vi.fn(),
    getActiveToolNames: vi.fn(),
    getAllTools: vi.fn(() => ["read", "bash", "edit"].map(name => ({ name }))),
    setActiveToolsByName: vi.fn(),
    // Promise-shaped like the real AgentSession. runAgent only awaits this
    // today, but a bare vi.fn() is the same contract lie that hid the missing
    // steer/abort rejection handling below.
    bindExtensions: vi.fn(async () => {}),
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }),
    prompt: vi.fn(async () => {
      for (const listener of [...listeners]) {
        listener({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
          },
        });
      }
    }),
    // Must resolve: the real AgentSession returns Promise<void> for both. A
    // bare vi.fn() returning undefined let wireTurnTracking's missing rejection
    // handling pass unnoticed — keep these promise-shaped.
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    messages: [],
    _getListeners: () => listeners,
  };
}

/* ------------------------------------------------------------------ */
/*  runAgent — session state inheritance                               */
/* ------------------------------------------------------------------ */

describe("runAgent — session state inheritance", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("copies only the latest custom entry for each type into the child session", async () => {
    const childSessionManager = { appendCustomEntry: vi.fn() };
    mockModules.mockSessionManagerInMemory.mockReturnValue(childSessionManager);
    const latestFastData = { enabled: true, nested: { value: 1 } };

    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    const ctx = fakeCtx();
    ctx.sessionManager = {
      getBranch: () => [
        { type: "custom", customType: "cliproxyapi-fast-mode", data: { enabled: false } },
        { type: "custom", customType: "other-extension", data: { value: 1 } },
        { type: "custom", customType: "subagents-lite:pending-result", data: { deliveryId: "pending-1" } },
        { type: "custom", customType: "subagents-lite:result-ack", data: { deliveryIds: ["pending-1"] } },
        { type: "message", message: {} },
        { type: "custom", customType: "cliproxyapi-fast-mode", data: latestFastData },
      ],
    };

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    expect(childSessionManager.appendCustomEntry).toHaveBeenCalledTimes(2);
    expect(childSessionManager.appendCustomEntry).toHaveBeenNthCalledWith(
      1,
      "other-extension",
      { value: 1 },
    );
    expect(childSessionManager.appendCustomEntry).toHaveBeenNthCalledWith(
      2,
      "cliproxyapi-fast-mode",
      latestFastData,
    );
    expect(childSessionManager.appendCustomEntry).not.toHaveBeenCalledWith(
      "subagents-lite:pending-result",
      expect.anything(),
    );
    expect(childSessionManager.appendCustomEntry).not.toHaveBeenCalledWith(
      "subagents-lite:result-ack",
      expect.anything(),
    );
    const inheritedFastData = childSessionManager.appendCustomEntry.mock.calls[1][1];
    inheritedFastData.nested.value = 2;
    expect(latestFastData).toEqual({ enabled: true, nested: { value: 1 } });
  });

  it("disposes setup immediately when the parent signal was already aborted", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    const controller = new AbortController();
    controller.abort();

    await expect(runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      signal: controller.signal,
    })).rejects.toThrow("Agent session setup aborted");

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it.each([
    ["output_blocked", "content was flagged"],
    ["provider_error", "provider error after session setup"],
  ] as const)("injects %s after session setup without prompting the provider", async (debugFault, message) => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    const onSessionCreated = vi.fn();

    await expect(runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      debugFault,
      onSessionCreated,
    })).rejects.toThrow(message);

    expect(onSessionCreated).toHaveBeenCalledWith(session);
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("rejects provider failures encoded as empty terminal assistant messages", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    session.prompt.mockImplementation(async () => {
      for (const listener of [...session._getListeners()]) {
        listener({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            stopReason: "error",
            errorMessage: "503 service_unavailable",
          },
        });
      }
    });
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    await expect(runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi }))
      .rejects.toThrow("503 service_unavailable");
    expect(session._getListeners()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — tool visibility wiring                                  */
/*  Policy matrix lives in agent-types-resolver.test.ts.               */
/*  Here: config + loader extensions reach setActiveToolsByName once.  */
/* ------------------------------------------------------------------ */

describe("runAgent — tool visibility wiring", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("disposes a session when setup is aborted while extension binding is stuck", async () => {
    const bind = makeResolvablePromise<void>();
    const session = createMockSession();
    session.bindExtensions.mockReturnValue(bind.promise);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    const controller = new AbortController();

    const run = runAgent(fakeCtx(), "test-agent", "task", {
      pi: fakePi,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(session.bindExtensions).toHaveBeenCalledTimes(1));
    controller.abort();
    await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledTimes(1));

    bind.resolve(undefined);
    await expect(run).rejects.toThrow("Agent session setup aborted");
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("includes extension tools registered during session_start before applying visibility", async () => {
    const extensionTools = new Map<string, unknown>([["web_search", {}]]);
    const session = createMockSession();
    session.bindExtensions.mockImplementation(async () => {
      extensionTools.set("web_extract", {});
      session.getAllTools.mockReturnValue([
        "read", "bash", "edit", "web_search", "web_extract", "Agent",
      ].map(name => ({ name })));
    });
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily"],
      tools: ["read", "tavily/*"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
      tools: ["read", "tavily/*"],
    });
    mockModules.setLoaderExtensions([{
      path: "/home/test/.pi/agent/extensions/tavily/index.ts",
      tools: extensionTools,
    }]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const sessionOptions = mockModules.mockCreateAgentSession.mock.calls[0][0];
    expect(sessionOptions.tools).toBeUndefined();
    expect(session.setActiveToolsByName).toHaveBeenCalledWith([
      "read", "web_search", "web_extract",
    ]);
  });

  it("keeps explicit registeredTools as the session capability boundary", async () => {
    const session = createMockSession();
    session.getAllTools.mockReturnValue(["read", "bash"].map(name => ({ name })));
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      registeredTools: ["read", "bash"],
    });
    mockModules.mockGetToolNamesForType.mockReturnValue(["read", "bash"]);
    mockModules.setLoaderExtensions([{
      path: "/home/test/.pi/agent/extensions/tavily/index.ts",
      tools: new Map([["web_search", {}]]),
    }]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const sessionOptions = mockModules.mockCreateAgentSession.mock.calls[0][0];
    expect(sessionOptions.tools).toEqual(["read", "bash"]);
    expect(sessionOptions.tools).not.toContain("web_search");
  });

  it("uses an accepted alternate model without rechecking current routing policy", async () => {
    const session = createMockSession();
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    const ctx = fakeCtx();
    ctx.model = { provider: "parent", id: "main-model" };

    await runAgent(ctx, "test-agent", "do something", {
      pi: fakePi,
      model: { provider: "other", id: "worker-model" },
    });

    expect(mockModules.mockCreateAgentSession.mock.calls[0][0].model).toEqual({
      provider: "other",
      id: "worker-model",
    });
  });

  it("allows an accepted explicit model when the parent is absent", async () => {
    const session = createMockSession();
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    const ctx = fakeCtx();
    ctx.model = undefined;

    await runAgent(ctx, "test-agent", "do something", {
      pi: fakePi,
      model: { provider: "other", id: "worker-model" },
    });

    expect(mockModules.mockCreateAgentSession).toHaveBeenCalledOnce();
  });

  it("rejects when neither the invocation nor parent supplies a model", async () => {
    const ctx = fakeCtx();
    ctx.model = undefined;
    await expect(runAgent(ctx, "test-agent", "do something", { pi: fakePi }))
      .rejects.toThrow("no subagent model could be resolved");
  });

  it("keeps a resolved undefined thinking snapshot from reading live defaults", async () => {
    const session = createMockSession();
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockDefaultThinking = "xhigh";

    await runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      thinkingLevel: undefined,
      thinkingResolved: true,
    });

    expect(mockModules.mockCreateAgentSession.mock.calls[0][0].thinkingLevel).toBeUndefined();
  });

  it("uses the invocation scope and thinking snapshot instead of live context", async () => {
    const session = createMockSession();
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    const model = { provider: "anthropic", id: "claude-opus-5" };
    const acceptedScope = [{ model, thinkingLevel: "high" }];
    const ctx = fakeCtx();
    ctx.model = { provider: "openai", id: "gpt-5.4" };
    ctx.scopedModels = [{ model: ctx.model, thinkingLevel: "medium" }];

    await runAgent(ctx, "test-agent", "do something", {
      pi: fakePi,
      model,
      scopedModels: acceptedScope,
      thinkingLevel: "high",
    });

    const sessionOptions = mockModules.mockCreateAgentSession.mock.calls[0][0];
    expect(sessionOptions.model).toEqual(model);
    expect(sessionOptions.scopedModels).toEqual(acceptedScope);
    expect(sessionOptions.thinkingLevel).toBe("high");
  });

  it("applies an empty tool list when tools are disabled", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      tools: false,
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(session.setActiveToolsByName).toHaveBeenCalledWith([]);
  });

  it("flushes resolver warnings through the runner notification buffer", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      tools: ["read", "missing-tool"],
    });
    const ctx = fakeCtx();
    ctx.ui = { notify: vi.fn() };

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('tool "missing-tool" not found in any loaded extension'),
      "warning",
    );
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — Codex stream disconnect retry                           */
/* ------------------------------------------------------------------ */

describe("runAgent — transient transport retry", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("extends Pi retry classification without changing existing results", async () => {
    type RetryMessage = { stopReason?: string; errorMessage?: string };
    const session = createMockSession() as ReturnType<typeof createMockSession> & {
      _isRetryableError: (message: RetryMessage) => boolean;
    };
    const originalClassifier = vi.fn(function (this: unknown, message: RetryMessage) {
      return message.errorMessage === "existing retryable error";
    });
    session._isRetryableError = originalClassifier;
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const classifyRetryableError = session._isRetryableError;
    for (const errorMessage of [
      "Codex error: stream disconnected before completion",
      "Codex error: stream closed before response.completed",
      "Codex error: invalid SSE data JSON: truncated payload",
      "stream_read_error: upstream closed the response",
      'Codex error: Post "https://chatgpt.com/backend-api/codex/responses": EOF',
      "existing retryable error",
    ]) {
      expect(classifyRetryableError({ stopReason: "error", errorMessage })).toBe(true);
    }
    expect(classifyRetryableError({ stopReason: "error", errorMessage: "invalid request" })).toBe(false);
    expect(classifyRetryableError({
      stopReason: "stop",
      errorMessage: "stream disconnected before completion",
    })).toBe(false);
    expect(originalClassifier).toHaveBeenCalledTimes(8);
    expect(originalClassifier.mock.contexts.every((context) => context === session)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  subscribeToSessionEvents — usage extraction                        */
/* ------------------------------------------------------------------ */

describe("subscribeToSessionEvents — usage extraction", () => {
  it("extracts u.cost?.total from assistant message_end events", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();
    expect(listeners).toHaveLength(1);

    // Fire assistant message_end with cost data on event.message.usage
    listeners[0]({
      type: "message_end",
      message: {
        role: "assistant",
        content: "Hello",
        usage: { input: 100, output: 50, cacheWrite: 10, cost: { total: 2.5 } },
      },
    });

    expect(onAssistantUsage).toHaveBeenCalledWith({
      input: 100,
      output: 50,
      cacheWrite: 10,
      cost: 2.5,
    });

    unsub();
  });

  it("includes nested usage reported by tool results", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();
    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    session._getListeners()[0]({
      type: "message_end",
      message: {
        role: "toolResult",
        usage: { input: 20, output: 10, cacheWrite: 5, cost: { total: 0.75 } },
      },
    });

    expect(onAssistantUsage).toHaveBeenCalledWith({
      input: 20,
      output: 10,
      cacheWrite: 5,
      cost: 0.75,
    });
    unsub();
  });

  it("includes usage from successful compactions", () => {
    const onAssistantUsage = vi.fn();
    const onCompaction = vi.fn();
    const session = createMockSession();
    const unsub = subscribeToSessionEvents(session, { onAssistantUsage, onCompaction });

    session._getListeners()[0]({
      type: "compaction_end",
      aborted: false,
      result: {
        usage: { input: 30, output: 15, cacheWrite: 0, cost: { total: 1.25 } },
      },
    });

    expect(onAssistantUsage).toHaveBeenCalledWith({
      input: 30,
      output: 15,
      cacheWrite: 0,
      cost: 1.25,
    });
    expect(onCompaction).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("defaults cost to 0 when message.usage has no cost field", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();

    // Fire message_end with message.usage but no cost
    listeners[0]({
      type: "message_end",
      message: {
        role: "assistant",
        content: "Hello",
        usage: { input: 100, output: 50, cacheWrite: 10 },
      },
    });

    expect(onAssistantUsage).toHaveBeenCalledWith({
      input: 100,
      output: 50,
      cacheWrite: 10,
      cost: 0,
    });

    unsub();
  });

  it("defaults cost to 0 when cost.total is null", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();

    listeners[0]({
      type: "message_end",
      message: {
        role: "assistant",
        content: "Hello",
        usage: { input: 100, output: 50, cacheWrite: 10, cost: { total: null } },
      },
    });

    expect(onAssistantUsage).toHaveBeenCalledWith({
      input: 100,
      output: 50,
      cacheWrite: 10,
      cost: 0,
    });

    unsub();
  });

  it("does not fire onAssistantUsage for user message_end events", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();

    // Fire user message_end (should be ignored)
    listeners[0]({
      type: "message_end",
      message: {
        role: "user",
        content: "Hello",
        usage: { input: 0, output: 0, cacheWrite: 0, cost: { total: 100 } },
      },
    });

    expect(onAssistantUsage).not.toHaveBeenCalled();

    unsub();
  });

  it("does not fire onAssistantUsage for other event types", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();

    // Fire non-message_end event
    listeners[0]({
      type: "turn_end",
    });

    expect(onAssistantUsage).not.toHaveBeenCalled();

    unsub();
  });

  it("does not fire onAssistantUsage when usage is missing", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();

    // Fire message_end without usage at all
    listeners[0]({
      type: "message_end",
      message: { role: "assistant", content: "Hello" },
      // no usage field
    });

    expect(onAssistantUsage).not.toHaveBeenCalled();

    unsub();
  });

  it("returns a noop unsubscribe when no callbacks are provided", () => {
    const session = createMockSession();
    const unsub = subscribeToSessionEvents(session, {});
    expect(typeof unsub).toBe("function");
  });
});

/* ------------------------------------------------------------------ */
/*  continueAgentSession                                               */
/* ------------------------------------------------------------------ */

describe("continueAgentSession", () => {
  it("prompts the existing session and forwards record-tracking callbacks", async () => {
    const session = createMockSession();
    const onTurnEnd = vi.fn();
    const onToolUse = vi.fn();

    session.prompt.mockImplementation(async () => {
      const listeners = [...session._getListeners()];
      for (const listener of listeners) {
        listener({ type: "tool_execution_start", toolName: "read" });
        listener({ type: "tool_execution_end", toolName: "read" });
        listener({ type: "turn_end" });
        listener({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "continued" }],
            stopReason: "stop",
          },
        });
      }
    });

    const result = await continueAgentSession(session as any, "next task", {
      onTurnEnd,
      onToolUse,
    });

    expect(session.prompt).toHaveBeenCalledWith("next task", undefined);
    expect(result).toEqual({
      responseText: "continued",
      aborted: false,
      turnLimited: false,
    });
    expect(onTurnEnd).toHaveBeenCalledWith(1);
    expect(onToolUse).toHaveBeenCalledTimes(1);
    expect(session._getListeners()).toHaveLength(0);
  });

  it("forwards images to the existing session", async () => {
    const session = createMockSession();
    const images = [{ type: "image", data: "abc", mimeType: "image/png" }] as any;

    await continueAgentSession(session as any, "inspect", { images });

    expect(session.prompt).toHaveBeenCalledWith("inspect", { images });
  });

  it("rejects empty successful terminal messages", async () => {
    const session = createMockSession();
    session.prompt.mockImplementation(async () => {
      for (const listener of [...session._getListeners()]) {
        listener({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            stopReason: "stop",
          },
        });
      }
    });

    await expect(continueAgentSession(session as any, "continue"))
      .rejects.toThrow("Subagent completed without final assistant text");
  });

  it("classifies an empty terminal abort without treating it as completion", async () => {
    const session = createMockSession();
    session.prompt.mockImplementation(async () => {
      for (const listener of [...session._getListeners()]) {
        listener({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            stopReason: "aborted",
          },
        });
      }
    });

    await expect(continueAgentSession(session as any, "continue")).resolves.toEqual({
      responseText: "",
      aborted: true,
      turnLimited: false,
    });
  });

  it("enforces max turns and grace turns on continuation prompts", async () => {
    const session = createMockSession();
    session.prompt.mockImplementation(async () => {
      for (let i = 0; i < 2; i++) {
        for (const listener of [...session._getListeners()]) {
          listener({ type: "turn_end" });
        }
      }
    });

    const result = await continueAgentSession(session as any, "continue", {
      maxTurns: 1,
      graceTurns: 0,
    });

    // Assert the contract, not the sentence: the steer must quantify both the
    // limit that fired and the budget left, so the model can act on it. Pinning
    // the literal text just breaks on every wording change.
    const steerMessage = session.steer.mock.calls[0][0] as string;
    expect(steerMessage).toContain("turn limit of 1");
    expect(steerMessage).toContain("1 turn(s) left");
    expect(session.abort).toHaveBeenCalled();
    expect(result.aborted).toBe(true);
    expect(result.turnLimited).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — extension name-based filtering                         */
/* ------------------------------------------------------------------ */

describe("runAgent — extension name-based filtering", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("passes extensionsOverride that filters to listed extensions", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search", "glob",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
    });
    // Don't pre-set loader extensions — the override should filter them
    mockModules.clearLoaderExtensions();

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    expect(loaderCall.noExtensions).toBe(false);
    expect(typeof loaderCall.extensionsOverride).toBe("function");

    // Verify the override filters correctly
    const override = loaderCall.extensionsOverride;
    const result = override({
      extensions: [
        { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
        { path: "/home/test/.pi/agent/extensions/extra-tools/glob.ts", tools: new Map([["glob", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toContain("tavily");
  });

  it("extensionsOverride extracts extension name from ext/tool syntax", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily/web_search"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    expect(typeof loaderCall.extensionsOverride).toBe("function");

    // The override should resolve "tavily/web_search" → "tavily" for extension loading
    const override = loaderCall.extensionsOverride;
    const result = override({
      extensions: [
        { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
        { path: "/home/test/.pi/agent/extensions/other/index.ts", tools: new Map([["other_tool", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toContain("tavily");
  });

  it("no extensionsOverride when extensions=true", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: true,
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    expect(loaderCall.noExtensions).toBe(false);
    expect(loaderCall.extensionsOverride).toBeUndefined();
  });

  it("no extensionsOverride when extensions=false", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: false,
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    expect(loaderCall.noExtensions).toBe(true);
    expect(loaderCall.extensionsOverride).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — excludeExtensions (blacklist mode)                      */
/* ------------------------------------------------------------------ */

describe("runAgent — excludeExtensions (blacklist mode)", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("excludeExtensions filters out listed extensions", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: true,
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: true,
      excludeExtensions: ["quality-monitor"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    expect(loaderCall.noExtensions).toBe(false);
    expect(typeof loaderCall.extensionsOverride).toBe("function");

    // Verify the override filters correctly
    const override = loaderCall.extensionsOverride;
    const result = override({
      extensions: [
        { path: "/home/test/.pi/agent/extensions/quality-monitor/index.ts", tools: new Map() },
        { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toContain("tavily");
  });

  it("excludeExtensions ignored when extensions whitelist is set", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily"],
      excludeExtensions: ["quality-monitor"], // ignored
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    // extensions whitelist wins — override should filter to only tavily
    const override = loaderCall.extensionsOverride;
    const result = override({
      extensions: [
        { path: "/home/test/.pi/agent/extensions/quality-monitor/index.ts", tools: new Map() },
        { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toContain("tavily");
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — grace turns                                            */
/* ------------------------------------------------------------------ */

describe("runAgent — grace turns", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  /**
   * Helper: create a mock session with a pending prompt (doesn't resolve
   * until resolvePrompt() is called). This allows firing turn_end events
   * while the agent is still running.
   */
  function createPendingPromptSession() {
    const session = createMockSession();
    let resolvePrompt!: () => void;
    session.prompt = vi.fn(
      () => new Promise<void>((r) => {
        resolvePrompt = r;
      }),
    );
    return { session, resolvePrompt: () => resolvePrompt() };
  }

  it("uses default grace turns (6) when not specified in options", async () => {
    const { session, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // maxTurns=1, no graceTurns → default 6 → steer at turn 1, abort at turn 1+6=7
    const promise = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      maxTurns: 1,
    });

    // Wait for the session to be created and prompt to be called
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });

    // Fire 6 turns (within default grace period) — should not abort
    for (let i = 0; i < 6; i++) {
      session._getListeners().forEach((fn: any) => fn({ type: "turn_end" }));
    }

    // The steer should have been called at turn 1
    expect(session.steer).toHaveBeenCalled();
    // Should not abort within grace period
    expect(session.abort).not.toHaveBeenCalled();

    // Now fire the 7th turn — should abort (maxTurns=1 + graceTurns=6 = 7)
    session._getListeners().forEach((fn: any) => fn({ type: "turn_end" }));
    expect(session.abort).toHaveBeenCalled();

    resolvePrompt();
    const result = await promise;
    expect(result.aborted).toBe(true);
  });

  it("uses custom grace turns from options", async () => {
    const { session, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // maxTurns=2, graceTurns=3 → steer at turn 2, abort at turn 2+3=5
    const promise = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      maxTurns: 2,
      graceTurns: 3,
    });

    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });

    // Fire 4 turns (within custom grace period) — should not abort
    for (let i = 0; i < 4; i++) {
      session._getListeners().forEach((fn: any) => fn({ type: "turn_end" }));
    }

    // The steer should have been called at turn 2
    expect(session.steer).toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();

    // Now fire the 5th turn — should abort (maxTurns=2 + graceTurns=3 = 5)
    session._getListeners().forEach((fn: any) => fn({ type: "turn_end" }));
    expect(session.abort).toHaveBeenCalled();

    resolvePrompt();
    const result = await promise;
    expect(result.aborted).toBe(true);
  });

  it("graceTurns=0 allows one turn after steer then aborts", async () => {
    const { session, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // maxTurns=2, graceTurns=0 → steer at turn 2, abort at turn 3
    // (steer and abort can't fire on same turn due to if/else-if structure)
    const promise = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      maxTurns: 2,
      graceTurns: 0,
    });

    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });

    // Fire 2 turns — steer fires at turn 2, no abort yet
    for (let i = 0; i < 2; i++) {
      session._getListeners().forEach((fn: any) => fn({ type: "turn_end" }));
    }

    expect(session.steer).toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();

    // Fire 1 more turn — abort fires at turn 3 (maxTurns + graceTurns = 2)
    session._getListeners().forEach((fn: any) => fn({ type: "turn_end" }));
    expect(session.abort).toHaveBeenCalled();

    resolvePrompt();
    const result = await promise;
    expect(result.aborted).toBe(true);
  });

  it("quantifies the turn budget in the steer message", async () => {
    const { session, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    const promise = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      maxTurns: 4,
      graceTurns: 3,
    });
    await vi.waitFor(() => { expect(session.prompt).toHaveBeenCalled(); });

    for (let i = 0; i < 4; i++) {
      session._getListeners().forEach((fn: any) => fn({ type: "turn_end" }));
    }

    const message = session.steer.mock.calls[0][0] as string;
    expect(message).toContain("turn limit of 4");
    expect(message).toContain("3 turn(s) left");

    resolvePrompt();
    await promise;
  });

  it("reports one remaining turn when graceTurns is 0", async () => {
    const { session, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // graceTurns 0 and 1 both leave exactly one usable turn (see the
    // graceTurns=0 case above) — the steer must not promise zero.
    const promise = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      maxTurns: 2,
      graceTurns: 0,
    });
    await vi.waitFor(() => { expect(session.prompt).toHaveBeenCalled(); });

    for (let i = 0; i < 2; i++) {
      session._getListeners().forEach((fn: any) => fn({ type: "turn_end" }));
    }

    expect(session.steer.mock.calls[0][0] as string).toContain("1 turn(s) left");

    resolvePrompt();
    await promise;
  });

  it("attaches rejection handlers to steer and abort", async () => {
    const { session, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // Both calls fire from inside a subscribe callback, so a rejected promise
    // escapes the run entirely instead of failing it — under
    // --unhandled-rejections=throw that takes down the host process. Rejection
    // is realistic here: steer/abort target a session already tearing down.
    //
    // Asserted via a .catch spy rather than process.on("unhandledRejection"):
    // vitest's runner intercepts unhandled rejections, so the leak version of
    // this test passed and reported nothing. That couples the test to `.catch`
    // specifically — rewriting the guard as try/await/catch would need this
    // updated.
    const steerPromise = Promise.reject(new Error("session closing"));
    const abortPromise = Promise.reject(new Error("already aborting"));
    // Mark handled before spying: the guard only attaches its handler a few
    // ticks later, and the gap would otherwise make the test itself leak.
    // spyOn installs an own `catch` afterwards, so the guard still hits the spy.
    steerPromise.catch(() => {});
    abortPromise.catch(() => {});
    const steerCatch = vi.spyOn(steerPromise, "catch");
    const abortCatch = vi.spyOn(abortPromise, "catch");
    session.steer = vi.fn(() => steerPromise);
    session.abort = vi.fn(() => abortPromise);

    const promise = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      maxTurns: 1,
      graceTurns: 1,
    });
    await vi.waitFor(() => { expect(session.prompt).toHaveBeenCalled(); });

    // Turn 1 steers, turn 2 hard-aborts.
    for (let i = 0; i < 2; i++) {
      session._getListeners().forEach((fn: any) => fn({ type: "turn_end" }));
    }

    expect(steerCatch).toHaveBeenCalled();
    expect(abortCatch).toHaveBeenCalled();

    resolvePrompt();
    const result = await promise;
    // A rejected abort() must not change the reported outcome.
    expect(result.aborted).toBe(true);
  });

  it("agent completes gracefully within grace period", async () => {
    const { session, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // maxTurns=1, graceTurns=5 → steer at turn 1, abort at turn 6
    const promise = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      maxTurns: 1,
      graceTurns: 5,
    });

    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });

    // Fire 3 turns (within grace period) — should steer but not abort
    for (let i = 0; i < 3; i++) {
      session._getListeners().forEach((fn: any) => fn({ type: "turn_end" }));
    }

    expect(session.steer).toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();

    resolvePrompt();
    const result = await promise;
    expect(result.aborted).toBe(false);
    expect(result.turnLimited).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — maxTokens: front matter → native model limit           */
/* ------------------------------------------------------------------ */

describe("runAgent — maxTokens: front matter to native model limit", () => {
  let session: ReturnType<typeof createMockSession> & { agent: { onPayload: unknown } };
  let originalOnPayload: unknown;

  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });

    session = Object.assign(createMockSession(), { agent: { onPayload: vi.fn() } });
    originalOnPayload = session.agent.onPayload;
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
  });

  function makeMockModel(overrides = {}) {
    return {
      id: "test-model",
      name: "Test Model",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://test.api/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
      samplingParams: { temperature: 0.2 },
      ...overrides,
    };
  }

  it("applies max_tokens to the child model without mutating the source model", async () => {
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 4096,
    });

    const model = makeMockModel();
    const ctx = fakeCtx();
    ctx.model = model;
    await runAgent(ctx, "test-agent", "do something", { pi: fakePi, model });

    const childModel = mockModules.mockCreateAgentSession.mock.calls[0][0].model;
    expect(childModel).not.toBe(model);
    expect(childModel).toEqual({ ...model, maxTokens: 4096 });
    expect(model.maxTokens).toBe(16384);
    expect(session.agent.onPayload).toBe(originalOnPayload);
  });

  it("preserves the model limit when max_tokens is omitted", async () => {
    mockModules.mockGetAgentConfig.mockReturnValue({ ...defaultAgentConfig });
    const model = makeMockModel();
    const ctx = fakeCtx();
    ctx.model = model;

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi, model });

    expect(mockModules.mockCreateAgentSession.mock.calls[0][0].model.maxTokens).toBe(16384);
    expect(session.agent.onPayload).toBe(originalOnPayload);
  });

  it("ignores a zero max_tokens override", async () => {
    mockModules.mockGetAgentConfig.mockReturnValue({ ...defaultAgentConfig, maxTokens: 0 });
    const model = makeMockModel();
    const ctx = fakeCtx();
    ctx.model = model;

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi, model });

    expect(mockModules.mockCreateAgentSession.mock.calls[0][0].model.maxTokens).toBe(16384);
    expect(session.agent.onPayload).toBe(originalOnPayload);
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — context file gating (includeContextFiles)              */
/* ------------------------------------------------------------------ */

describe("runAgent — context file gating", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("loads context files when includeContextFiles is true", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockIncludeContextFiles = true;
    mockModules.mockLoadProjectContextFiles.mockReturnValue([
      { path: "AGENTS.md", content: "project instructions" },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(mockModules.mockLoadProjectContextFiles).toHaveBeenCalled();
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        contextFiles: [{ path: "AGENTS.md", content: "project instructions" }],
      }),
      expect.anything(),
    );
  });

  it("does NOT load context files when includeContextFiles is false", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockIncludeContextFiles = false;

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(mockModules.mockLoadProjectContextFiles).not.toHaveBeenCalled();
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ contextFiles: expect.anything() }),
      expect.anything(),
    );
  });

  it("context file loading failure is non-fatal", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockIncludeContextFiles = true;
    mockModules.mockLoadProjectContextFiles.mockImplementation(() => {
      throw new Error("permission denied");
    });

    // Should not throw
    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(mockModules.mockLoadProjectContextFiles).toHaveBeenCalled();
    // buildAgentPrompt still called (without contextFiles)
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — system prompt modes (replace, inherit, custom)         */
/* ------------------------------------------------------------------ */

describe("runAgent — system prompt modes", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("uses replace mode by default — passes 'replace' to buildAgentPrompt", async () => {
    mockModules.mockSystemPromptMode = "replace";
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "replace",
    );
  });

  it("calls ctx.getSystemPrompt() when mode is inherit", async () => {
    mockModules.mockSystemPromptMode = "inherit";
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    const ctx = fakeCtx();
    ctx.getSystemPrompt = vi.fn().mockReturnValue("parent prompt content");

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    expect(ctx.getSystemPrompt).toHaveBeenCalled();
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ parentSystemPrompt: "parent prompt content" }),
      "inherit",
    );
  });

  it("falls back gracefully when getSystemPrompt throws in inherit mode", async () => {
    mockModules.mockSystemPromptMode = "inherit";
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    const ctx = fakeCtx();
    ctx.getSystemPrompt = vi.fn().mockImplementation(() => { throw new Error("no prompt"); });
    ctx.ui = { notify: vi.fn() };

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    // Notified about the failure
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Failed to get parent system prompt"),
      "warning",
    );
    // buildAgentPrompt still called — without parentSystemPrompt
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ parentSystemPrompt: expect.anything() }),
      "inherit",
    );
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — custom mode (file reading, fallback)                   */
/* ------------------------------------------------------------------ */

describe("runAgent — custom mode", () => {
  let fsReadFileSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
    mockModules.mockSystemPromptMode = "custom";
    fsReadFileSyncSpy = vi.spyOn(fs, "readFileSync");
  });

  afterEach(() => {
    fsReadFileSyncSpy.mockRestore();
  });

  it("reads custom prompt file and passes content to buildAgentPrompt", async () => {
    fsReadFileSyncSpy.mockReturnValue("My custom system prompt");
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(fsReadFileSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining("subagents-lite-prompt.md"),
      "utf-8",
    );
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ customSystemPrompt: "My custom system prompt" }),
      "custom",
    );
  });

  it("falls back when custom file is missing (ENOENT)", async () => {
    const err = new Error("ENOENT") as any;
    err.code = "ENOENT";
    fsReadFileSyncSpy.mockImplementation(() => { throw err; });
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    const ctx = fakeCtx();
    ctx.ui = { notify: vi.fn() };

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Custom prompt file not found"),
      "warning",
    );
    // buildAgentPrompt called without customSystemPrompt
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ customSystemPrompt: expect.anything() }),
      "custom",
    );
  });

  it("falls back when custom file is empty", async () => {
    fsReadFileSyncSpy.mockReturnValue("   "); // whitespace only
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    const ctx = fakeCtx();
    ctx.ui = { notify: vi.fn() };

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Custom prompt file is empty"),
      "warning",
    );
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ customSystemPrompt: expect.anything() }),
      "custom",
    );
  });

  it("falls back when custom file is unreadable (other error)", async () => {
    fsReadFileSyncSpy.mockImplementation(() => { throw new Error("permission denied"); });
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    const ctx = fakeCtx();
    ctx.ui = { notify: vi.fn() };

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Failed to read custom prompt file"),
      "warning",
    );
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — notify buffering (session tree corruption fix)          */
/* ------------------------------------------------------------------ */

describe("runAgent — notify buffering", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  /**
   * Create a session where prompt doesn't resolve until resolvePrompt() is called.
   * This lets us check notify call ordering relative to the turn loop.
   */
  function createPendingPromptSession() {
    const session = createMockSession();
    let resolvePrompt!: () => void;
    session.prompt = vi.fn(
      () => new Promise<void>((r) => {
        resolvePrompt = r;
      }),
    );
    return {
      session,
      resolvePrompt: () => {
        for (const listener of [...session._getListeners()]) {
          listener({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              stopReason: "stop",
            },
          });
        }
        resolvePrompt();
      },
    };
  }

  it("does NOT call ctx.ui.notify before runTurnLoop completes", async () => {
    const { session, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // Trigger mutual exclusion warning (tools + excludeTools both set)
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      tools: ["read", "bash"],
      excludeTools: ["write"],
    });

    const ctx = fakeCtx();
    ctx.ui = {
      notify: vi.fn(),
    };

    const promise = runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    // At this point setup is done but prompt is still pending — notify should NOT have been called yet
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    expect(ctx.ui.notify).not.toHaveBeenCalled();

    // Complete the turn loop
    resolvePrompt();
    await promise;

    // Now notify should have been called (warnings flushed after turn loop)
    expect(ctx.ui.notify).toHaveBeenCalled();
  });

  it("flushes buffered warnings after turn loop", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // Trigger mutual exclusion warning (tools + excludeTools)
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      tools: ["read", "bash"],
      excludeTools: ["write"],
    });

    const ctx = fakeCtx();
    ctx.ui = { notify: vi.fn() };

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    // Should have exactly one warning (mutual exclusion)
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('both tools and exclude_tools set'),
      "warning",
    );
  });

  it("uses console.warn fallback when ctx.ui.notify is unavailable", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // Trigger mutual exclusion warning
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      tools: ["read", "bash"],
      excludeTools: ["write"],
    });

    const ctx = fakeCtx();
    // No ctx.ui — should fall back to console.warn

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('both tools and exclude_tools set'),
    );
  });

  it("console.warn fallback also waits until after turn loop", async () => {
    const { session, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // Trigger mutual exclusion warning
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      tools: ["read", "bash"],
      excludeTools: ["write"],
    });

    const ctx = fakeCtx();
    // No ctx.ui — console.warn fallback

    const promise = runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    // Setup done, prompt pending — console.warn should NOT have been called yet
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    expect(warnSpy).not.toHaveBeenCalled();

    // Complete the turn loop
    resolvePrompt();
    await promise;

    // Now console.warn should have been called
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('both tools and exclude_tools set'),
    );
  });
});
