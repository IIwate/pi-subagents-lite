/**
 * worktree-tool-execution.test.ts — Acceptance tests for worktree_path
 * validation in the Agent tool execution flow.
 *
 * Verifies:
 *   - Valid worktree_path: validator is called, spawn uses resolved path as cwd
 *   - Invalid worktree_path: validator error returned to LLM, no spawn
 *   - Omitted worktree_path: no validator call, spawn uses parent cwd
 *   - Error details from validator are surfaced to the LLM
 *
 * Tests the integration boundary between executeAgentTool and the validator.
 * Mocks the validator module and the spawn flow; tests observable behavior
 * (tool result content) not internal call order.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeCtx } from "../fixtures.ts";

/* ------------------------------------------------------------------ */
/*  Mock setup                                                        */
/* ------------------------------------------------------------------ */

// Use vi.hoisted so mock factories can reference these at hoisting time
const {
  mockValidateWorktreePath,
  mockSpawn,
  mockGetRecord,
  mockDiscoverNewAgents,
  mockScopedModelKeys,
  mockRouting,
  mockForceBackground,
  mockSpawnIntents,
} = vi.hoisted(() => ({
  mockValidateWorktreePath: vi.fn(),
  mockSpawn: vi.fn().mockReturnValue("agent-id-123"),
  mockGetRecord: vi.fn(),
  mockDiscoverNewAgents: vi.fn(async () => 0),
  mockScopedModelKeys: vi.fn(() => null),
  mockRouting: {
    enabled: false,
    enabledProviders: [] as string[],
    agentAccess: {} as Record<string, { providers: Record<string, { models?: string[] }> }>,
  },
  mockForceBackground: { value: false },
  mockSpawnIntents: [] as any[],
}));

vi.mock("../../src/spawn/worktree-validator.js", () => ({
  validateWorktreePath: mockValidateWorktreePath,
}));

vi.mock("../../src/agents/agent-types.js", () => ({
  resolveType: vi.fn((type: string) => type),
  getAgentConfig: vi.fn(() => ({ maxTurns: 25, thinkingLevel: undefined })),
  discoverNewAgents: mockDiscoverNewAgents,
}));

vi.mock("../../src/models/model-scope.js", () => ({
  // Scope policy itself is covered in model-scope.test.ts; this suite verifies
  // that executeAgentTool enforces the returned scope and surfaces its error.
  scopedModelKeys: mockScopedModelKeys,
  modelKey: ({ provider, id }: { provider: string; id: string }) => `${provider}/${id}`,
  scopedThinkingLevel: (
    scopedModels: Array<{ model: { provider: string; id: string }; thinkingLevel?: string }>,
    model: { provider: string; id: string } | undefined,
  ) => scopedModels.find(({ model: scopedModel }) =>
    model && scopedModel.provider === model.provider && scopedModel.id === model.id,
  )?.thinkingLevel,
  missingParentModelError: () =>
    "Cannot start an agent because the parent session has no active model. Select a parent model first.",
  missingSubagentModelError: () =>
    "Cannot start an agent because no subagent model could be resolved. Select a parent model or specify a model.",
  routingDisabledModelError: (modelRef: string) =>
    `Model "${modelRef}" cannot be used while Model routing is OFF.`,
  providerDisabledError: (modelRef: string, provider: string) =>
    `Model "${modelRef}" is not authorized: provider "${provider}" is disabled.`,
  agentProviderDeniedError: (modelRef: string, agent: string, provider: string) =>
    `Model "${modelRef}" is not authorized: Agent "${agent}" has no access to "${provider}".`,
  modelDeniedError: (modelRef: string, agent: string) =>
    `Model "${modelRef}" is not authorized for Agent "${agent}".`,
  modelUnavailableError: (modelRef: string) =>
    `Model "${modelRef}" is not currently available to Pi.`,
  outOfScopeModelError: (modelRef: string, scopedKeys: ReadonlySet<string>) =>
    `Model "${modelRef}" is not in the active model scope. Allowed: ${[...scopedKeys].join(", ")}.`,
}));

vi.mock("../../src/shell.js", () => ({
  getStore: () => ({
    get agent() {
      return {
        graceTurns: 5,
        forceBackground: mockForceBackground.value,
      };
    },
    get routing() {
      return structuredClone(mockRouting);
    },
  }),
  getPiInstance: () => ({ sendMessage: vi.fn(), exec: vi.fn() }),
  getSessionCtx: () => ({ cwd: "/home/test/project" }),
  getManager: () => ({
    spawn: mockSpawn,
    getRecord: mockGetRecord,
    listAgents: vi.fn(() => []),
    abort: vi.fn(() => false),
  }),
  getCoordinator: () => ({
    spawn: vi.fn(async (_pi: any, _ctx: any, intent: any) => {
      mockSpawnIntents.push(intent);
      // Delegate to the mocked manager.spawn
      const manager = {
        spawn: mockSpawn,
        getRecord: mockGetRecord,
      };
      const id = mockSpawn(_pi, _ctx, intent.type, intent.prompt, {
        description: intent.description,
        signal: intent.signal,
        model: intent.model,
        scopedModels: intent.scopedModels,
        maxTurns: intent.maxTurns,
        thinkingLevel: intent.thinkingLevel,
        thinkingResolved: intent.thinkingResolved,
        modelKey: intent.modelKey,
        graceTurns: intent.graceTurns,
        worktreePath: intent.worktreePath,
        invocation: intent.invocation,
      });
      const record = mockGetRecord(id);
      if (!intent.runInBackground && record?.execution?.promise) {
        await record.execution.promise;
      }
      return { agentId: id, record };
    }),
    onAgentComplete: vi.fn(),
    dispose: vi.fn(),
  }),
}));

// Import after mocks are in place
import { executeAgentTool } from "../../src/agents/tool-execution.js";
import * as agentTypes from "../../src/agents/agent-types.js";

beforeEach(() => {
  mockRouting.enabled = false;
  mockRouting.enabledProviders = [];
  mockRouting.agentAccess = {};
  mockForceBackground.value = false;
  mockSpawnIntents.length = 0;
});

/* ------------------------------------------------------------------ */
/*  Factories                                                         */
/* ------------------------------------------------------------------ */

function makeParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: "Do something useful",
    description: "Test agent",
    agent: "general-purpose",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("executeAgentTool — worktree_path validation", () => {
  let ctx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = fakeCtx();
    mockGetRecord.mockReturnValue({
      id: "agent-id-123",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "running", startedAt: Date.now() },
      execution: { promise: Promise.resolve("done") },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        toolUses: 0,
        compactionCount: 0,
      },
    });
  });

  it("calls the validator when worktree_path is provided", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/wt/feature",
    });

    await executeAgentTool("tc-1", makeParams({ worktree_path: "/wt/feature" }), undefined, undefined, ctx);

    expect(mockValidateWorktreePath).toHaveBeenCalledTimes(1);
    expect(mockValidateWorktreePath).toHaveBeenCalledWith(
      expect.anything(), // pi
      "/wt/feature",
      expect.any(String), // parent cwd
      expect.any(Function), // onWarning
    );
  });

  it("returns an error when worktree_path validation fails", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: false,
      error: "Path '/etc' is not inside a git repository",
    });

    const result = await executeAgentTool(
      "tc-2",
      makeParams({ worktree_path: "/etc" }),
      undefined,
      undefined,
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not inside a git repository");
    // Should NOT have spawned
    expect(mockSpawn).not.toHaveBeenCalled();
  });
  it("flushes validator warnings via ctx.ui.notify on validation failure", async () => {
    // Mock validateWorktreePath to invoke the onWarning callback before returning failure
    mockValidateWorktreePath.mockImplementation((_pi, _path, _cwd, onWarning) => {
      onWarning?.("git rev-parse --git-common-dir failed in /etc: EACCES permission denied");
      return Promise.resolve({ ok: false, error: "worktree_path validation failed: git rev-parse failed: EACCES permission denied" });
    });

    ctx.ui = { notify: vi.fn() };
    const result = await executeAgentTool(
      "tc-warn",
      makeParams({ worktree_path: "/etc" }),
      undefined,
      undefined,
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "[pi-subagents-lite] git rev-parse --git-common-dir failed in /etc: EACCES permission denied",
      "warning",
    );
  });


  it("does not call the validator when worktree_path is omitted", async () => {
    await executeAgentTool("tc-3", makeParams(), undefined, undefined, ctx);

    expect(mockValidateWorktreePath).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalled();
  });

  it("forwards the parent AbortSignal only to foreground agents", async () => {
    const controller = new AbortController();

    await executeAgentTool("tc-fg-signal", makeParams(), controller.signal, undefined, ctx);
    expect(mockSpawn.mock.calls[0][4].signal).toBe(controller.signal);

    vi.clearAllMocks();
    await executeAgentTool(
      "tc-bg-signal",
      makeParams({ run_in_background: true }),
      controller.signal,
      undefined,
      ctx,
    );
    expect(mockSpawn.mock.calls[0][4].signal).toBeUndefined();

    vi.clearAllMocks();
    mockForceBackground.value = true;
    await executeAgentTool("tc-forced-bg-signal", makeParams(), controller.signal, undefined, ctx);
    expect(mockSpawn.mock.calls[0][4].signal).toBeUndefined();
  });

  it("uses the resolved worktree path as cwd when validation succeeds", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/wt/feature",
    });

    await executeAgentTool("tc-4", makeParams({ worktree_path: "/wt/feature" }), undefined, undefined, ctx);

    // Verify spawn was called and worktree path was set on the record
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    // worktreePath is set on the record's display AFTER spawn, not in spawn options
    // Verify spawn received the worktree path via options
    const spawnCall = mockSpawn.mock.calls[0];
    const spawnOptions = spawnCall[4]; // options is 5th arg (pi, ctx, type, prompt, options)
    expect(spawnOptions.worktreePath).toBe("/wt/feature");
  });

  it("surfaces specific validator error reasons to the LLM", async () => {
    const rejectionReasons = [
      { error: "Path does not exist", match: "does not exist" },
      { error: "Path is not a directory", match: "not a directory" },
      { error: "Path is not inside a git repository", match: "not inside a git" },
      { error: "Path is inside a git repository that is not the parent's", match: "not the parent" },
      { error: "Parent itself is not in a git repository", match: "Parent" },
    ];

    for (const { error, match } of rejectionReasons) {
      vi.clearAllMocks();
      mockValidateWorktreePath.mockResolvedValue({ ok: false, error });

      const result = await executeAgentTool(
        "tc-err",
        makeParams({ worktree_path: "/some/path" }),
        undefined,
        undefined,
        ctx,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(match);
    }
  });

  it("returns a successful result when worktree_path is valid", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/wt/feature",
    });
    // Foreground spawn completes immediately
    mockGetRecord.mockReturnValue({
      id: "agent-id-123",
      result: "Agent completed successfully",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "completed", startedAt: Date.now() - 1000, completedAt: Date.now() },
      execution: { promise: Promise.resolve("Agent completed successfully") },
      stats: {
        lifetimeUsage: { input: 100, output: 50, cacheWrite: 0, cost: 0.01 },
        toolUses: 3,
        turnCount: 2,
        compactionCount: 0,
      },
    });

    const result = await executeAgentTool(
      "tc-ok",
      makeParams({ worktree_path: "/wt/feature" }),
      undefined,
      undefined,
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Agent completed successfully");
  });

  it("returns the recorded failure diagnostic for foreground agents", async () => {
    mockGetRecord.mockReturnValue({
      id: "agent-id-123",
      error: "503 service_unavailable",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "error", startedAt: Date.now(), completedAt: Date.now() },
      execution: { promise: Promise.resolve("") },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        toolUses: 0,
        compactionCount: 0,
      },
    });

    const result = await executeAgentTool("tc-error", makeParams(), undefined, undefined, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Agent failed: 503 service_unavailable");
  });

  it("does not crash the parent when validator throws unexpectedly", async () => {
    mockValidateWorktreePath.mockRejectedValue(new Error("Unexpected filesystem error"));

    const result = await executeAgentTool(
      "tc-crash",
      makeParams({ worktree_path: "/wt/feature" }),
      undefined,
      undefined,
      ctx,
    );

    // Should return an error result, not throw
    expect(result.isError).toBe(true);
  });
});

describe("executeAgentTool — worktree_path with background spawn", () => {
  let ctx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = fakeCtx();
    mockGetRecord.mockReturnValue({
      id: "agent-id-bg",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "running", startedAt: Date.now() },
      execution: { resultSessionId: "parent-session" },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        toolUses: 0,
        compactionCount: 0,
      },
    });
  });

  it("validates worktree_path for background spawns too", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/wt/feature",
    });

    const result = await executeAgentTool(
      "tc-bg",
      makeParams({ worktree_path: "/wt/feature", run_in_background: true }),
      undefined,
      undefined,
      ctx,
    );

    expect(mockValidateWorktreePath).toHaveBeenCalledTimes(1);
    expect(mockSpawnIntents.at(-1)).not.toHaveProperty("backgroundDelivery");
    expect(result.content[0].text).toContain("running");
    expect(result.content[0].text).toContain("delivered automatically");
  });

  it("returns error for invalid worktree_path in background spawn", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: false,
      error: "Path does not exist",
    });

    const result = await executeAgentTool(
      "tc-bg-err",
      makeParams({ worktree_path: "/nonexistent", run_in_background: true }),
      undefined,
      undefined,
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe("executeAgentTool — worktree_path discovery integration", () => {
  let ctx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = fakeCtx();
    mockGetRecord.mockReturnValue({
      id: "agent-id-disc",
      result: "Agent completed successfully",
      display: { type: "feature-reviewer", description: "Reviews feature" },
      lifecycle: { status: "completed", startedAt: Date.now() - 1000, completedAt: Date.now() },
      execution: { promise: Promise.resolve("Agent completed successfully") },
      stats: {
        lifetimeUsage: { input: 100, output: 50, cacheWrite: 0, cost: 0.01 },
        toolUses: 3,
        turnCount: 2,
        compactionCount: 0,
      },
    });
  });

  it("calls discoverNewAgents with worktree dir when type is not initially known", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/wt/feature",
    });

    // First resolveType call returns undefined (type not known)
    const resolveTypeSpy = vi.spyOn(agentTypes, "resolveType");
    resolveTypeSpy.mockReturnValueOnce(undefined); // first call — not found
    resolveTypeSpy.mockReturnValueOnce("feature-reviewer"); // after discovery — found

    await executeAgentTool(
      "tc-disc",
      makeParams({ agent: "feature-reviewer", worktree_path: "/wt/feature" }),
      undefined,
      undefined,
      ctx,
    );

    // Should have called discoverNewAgents with the worktree's .pi/agents dir
    expect(mockDiscoverNewAgents).toHaveBeenCalledTimes(1);
    expect(mockDiscoverNewAgents).toHaveBeenCalledWith("/wt/feature/.pi/agents");
  });

  it("calls discoverNewAgents without worktree dir when type is not known and worktree_path omitted", async () => {
    // First resolveType call returns undefined (type not known)
    const resolveTypeSpy = vi.spyOn(agentTypes, "resolveType");
    resolveTypeSpy.mockReturnValueOnce(undefined); // first call — not found
    resolveTypeSpy.mockReturnValueOnce("feature-reviewer"); // after discovery — found

    await executeAgentTool(
      "tc-disc-no-wt",
      makeParams({ agent: "feature-reviewer" }),
      undefined,
      undefined,
      ctx,
    );

    // Should have called discoverNewAgents WITHOUT a worktree dir
    expect(mockDiscoverNewAgents).toHaveBeenCalledTimes(1);
    expect(mockDiscoverNewAgents).toHaveBeenCalledWith(undefined);
  });
});

describe("executeAgentTool — thinking param", () => {
  let ctx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = fakeCtx();
    mockGetRecord.mockReturnValue({
      id: "agent-id-123",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "running", startedAt: Date.now() },
      execution: { promise: Promise.resolve("done") },
      stats: { toolUses: 0, turnCount: 1, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, compactionCount: 0 },
    });
  });

  it("forwards explicit thinking=low to spawn", async () => {
    await executeAgentTool(
      "tc-think",
      makeParams({ thinking: "low" }),
      undefined,
      undefined,
      ctx,
    );

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const spawnOptions = mockSpawn.mock.calls[0][4];
    expect(spawnOptions.thinkingLevel).toBe("low");
  });

  it("forwards free-form thinking values not in the known list", async () => {
    await executeAgentTool(
      "tc-think-custom",
      makeParams({ thinking: "super-high" }),
      undefined,
      undefined,
      ctx,
    );

    const spawnOptions = mockSpawn.mock.calls[0][4];
    expect(spawnOptions.thinkingLevel).toBe("super-high");
  });
});

describe("executeAgentTool — model access", () => {
  let ctx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRouting.enabled = true;
    mockRouting.enabledProviders = ["cpa-responses"];
    mockRouting.agentAccess = {
      "general-purpose": { providers: { "cpa-responses": { models: ["grok-4.5"] } } },
    };
    ctx = fakeCtx();
    ctx.model = { provider: "test", id: "parent-model" };
    const models = [
      { provider: "test", id: "parent-model" },
      { provider: "test", id: "other-model" },
      { provider: "cpa-responses", id: "grok-4.5" },
      { provider: "cpa-responses", id: "grok-5" },
    ];
    ctx.modelRegistry = {
      find: vi.fn((provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id)),
      getAll: vi.fn(() => models),
      getAvailable: vi.fn(() => models),
    };
    ctx.scopedModels = [];
    mockGetRecord.mockReturnValue({
      id: "agent-id-123",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "running", startedAt: Date.now() },
      execution: { promise: Promise.resolve("done") },
      stats: { toolUses: 0, turnCount: 1, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, compactionCount: 0 },
    });
  });

  it("uses the exact parent when model is omitted", async () => {
    await executeAgentTool("parent", makeParams({ model: undefined }), undefined, undefined, ctx);
    expect(mockSpawn.mock.calls[0][4].model).toEqual(ctx.model);
  });

  it("allows the exact parent explicitly while routing is OFF", async () => {
    mockRouting.enabled = false;
    await executeAgentTool("parent-explicit", makeParams({ model: "test/parent-model" }), undefined, undefined, ctx);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("uses the accepted parent object even when it is absent from the registry", async () => {
    mockRouting.enabled = false;
    ctx.modelRegistry.find.mockReturnValue(undefined);
    ctx.modelRegistry.getAll.mockReturnValue([]);
    ctx.modelRegistry.getAvailable.mockReturnValue([]);
    await executeAgentTool("parent-unregistered", makeParams({ model: "test/parent-model" }), undefined, undefined, ctx);
    expect(mockSpawn.mock.calls[0][4].model).toBe(ctx.model);
  });

  it("rejects every non-parent explicit model while routing is OFF", async () => {
    mockRouting.enabled = false;
    const result = await executeAgentTool("off", makeParams({ model: "test/other-model" }), undefined, undefined, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Model routing is OFF");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("requires a parent only when model is omitted", async () => {
    ctx.model = undefined;
    const omitted = await executeAgentTool("missing-parent", makeParams({ model: undefined }), undefined, undefined, ctx);
    expect(omitted.content[0].text).toContain("parent session has no active model");

    await executeAgentTool("explicit-no-parent", makeParams({ model: "cpa-responses/grok-4.5" }), undefined, undefined, ctx);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("requires the provider to be globally enabled", async () => {
    mockRouting.enabledProviders = [];
    const result = await executeAgentTool("provider", makeParams({ model: "cpa-responses/grok-4.5" }), undefined, undefined, ctx);
    expect(result.content[0].text).toContain("provider \"cpa-responses\" is disabled");
  });

  it("allows an explicit current-parent-provider alternate past only the global gate", async () => {
    mockRouting.enabledProviders = [];
    mockRouting.agentAccess = {
      "general-purpose": { providers: { test: { models: ["other-model"] } } },
    };
    await executeAgentTool(
      "parent-provider-alternate",
      makeParams({ model: "test/other-model" }),
      undefined,
      undefined,
      ctx,
    );
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mockRouting.agentAccess = {};
    const denied = await executeAgentTool(
      "parent-provider-no-rule",
      makeParams({ model: "test/other-model" }),
      undefined,
      undefined,
      ctx,
    );
    expect(denied.content[0].text).toContain("has no access");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("applies policy gates before registry availability for qualified models", async () => {
    mockRouting.enabledProviders = [];
    const result = await executeAgentTool("unknown-provider", makeParams({ model: "missing/worker" }), undefined, undefined, ctx);
    expect(result.content[0].text).toContain("provider \"missing\" is disabled");
    expect(result.content[0].text).not.toContain("Unknown model id");
  });

  it("requires an Agent/provider rule", async () => {
    mockRouting.agentAccess = {};
    const result = await executeAgentTool("agent-provider", makeParams({ model: "cpa-responses/grok-4.5" }), undefined, undefined, ctx);
    expect(result.content[0].text).toContain("has no access");
  });

  it("requires a matching exact model rule", async () => {
    const result = await executeAgentTool("model-rule", makeParams({ model: "cpa-responses/grok-5" }), undefined, undefined, ctx);
    expect(result.content[0].text).toContain("not authorized for Agent");
  });

  it("allows an all-model rule", async () => {
    mockRouting.agentAccess["general-purpose"].providers["cpa-responses"] = {};
    await executeAgentTool("all", makeParams({ model: "cpa-responses/grok-5" }), undefined, undefined, ctx);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("rejects catalogue-only alternate models", async () => {
    ctx.modelRegistry.getAvailable = vi.fn(() => [{ provider: "test", id: "parent-model" }]);
    const result = await executeAgentTool("availability", makeParams({ model: "cpa-responses/grok-4.5" }), undefined, undefined, ctx);
    expect(result.content[0].text).toContain("not currently available to Pi");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("rejects alternate models outside active scope", async () => {
    mockScopedModelKeys.mockReturnValueOnce(new Set(["test/parent-model"]));
    const result = await executeAgentTool("scope", makeParams({ model: "cpa-responses/grok-4.5" }), undefined, undefined, ctx);
    expect(result.content[0].text).toContain("active model scope");
  });

  it("resolves bare IDs from the full registry", async () => {
    await executeAgentTool("bare", makeParams({ model: "grok-4.5" }), undefined, undefined, ctx);
    expect(mockSpawn.mock.calls[0][4].model).toEqual({ provider: "cpa-responses", id: "grok-4.5" });
  });

  it("locks model, scope, and resolved thinking in the spawn intent", async () => {
    ctx.scopedModels = [{ model: { provider: "cpa-responses", id: "grok-4.5" }, thinkingLevel: "high" }];
    await executeAgentTool("snapshot", makeParams({ model: "grok-4.5" }), undefined, undefined, ctx);
    const options = mockSpawn.mock.calls[0][4];
    expect(options.model).toEqual({ provider: "cpa-responses", id: "grok-4.5" });
    expect(options.scopedModels).toEqual(ctx.scopedModels);
    expect(options.thinkingLevel).toBe("high");
    expect(options.thinkingResolved).toBe(true);
    expect(options.invocation.thinkingLevel).toBe("high");
  });

  it("prefers explicit thinking over model shorthand and scope", async () => {
    ctx.scopedModels = [{ model: { provider: "cpa-responses", id: "grok-4.5" }, thinkingLevel: "medium" }];
    await executeAgentTool(
      "thinking",
      makeParams({ model: "grok-4.5:low", thinking: "xhigh" }),
      undefined,
      undefined,
      ctx,
    );
    expect(mockSpawn.mock.calls[0][4].thinkingLevel).toBe("xhigh");
  });

  it("never falls back after an explicit denial", async () => {
    const result = await executeAgentTool("no-fallback", makeParams({ model: "cpa-responses/grok-5" }), undefined, undefined, ctx);
    expect(result.isError).toBe(true);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
