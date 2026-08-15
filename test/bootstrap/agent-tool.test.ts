/**
 * agent-tool.test.ts — Acceptance tests for the Agent tool executor.
 *
 * Every collaborator enters through a real seam instead of a module mock:
 *   - routing policy through runtime.modelAccess (composition-root record)
 *   - scheduling through a SubagentRuntime port double on the record
 *   - git probes through the runtime's pi.exec external port + real temp dirs
 *   - agent types through the runtime's own registry, seeded per test
 *
 * Detailed worktree failure reasons are owned by worktree-validator.test.ts;
 * this suite proves pre-spawn refusals throw, model access is enforced, and
 * a frozen accepted policy is handed to the spawn seam. Foreground snapshot
 * errors after spawn still return isError — that is a run result.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createAgentToolExecutor } from "../../src/bootstrap/agent-tool.js";
import { projectAgentsDirPath } from "../../src/platform/fs/config-paths.js";
import { createFsWorktreeInspector } from "../../src/platform/fs/worktree-inspector.js";
import { WORKTREE_VALIDATION_ERRORS } from "../../src/platform/fs/worktree-validator.js";
import type { AgentRegistry } from "../../src/bootstrap/agent-registry.js";
import type { ModelAccessFragment } from "../../src/modules/model-access/public.js";
import {
  disabledModelAccess,
  fakeCtx,
  fakeExtensionRuntime,
  inertAgentSettings,
  makeResolvablePromise,
  makeAgentMd,
  testAgentRegistry,
} from "../fixtures.ts";

/* ------------------------------------------------------------------ */
/*  Seam doubles and fixtures                                         */
/* ------------------------------------------------------------------ */

/**
 * SubagentRuntime port double. The executor's contract towards scheduling is
 * "one serializable spawn command in, one snapshot out"; recording commands
 * here keeps assertions on that boundary instead of on internal call order.
 */
function stubManager() {
  const spawnCommands: any[] = [];
  const stops: Array<{ id: string; initiator: string }> = [];
  const snapshot = {
    id: "agent-id-123",
    type: "general-purpose",
    status: "completed" as string,
    result: "Agent completed successfully" as string | undefined,
    error: undefined as string | undefined,
  };
  const manager = {
    execute: vi.fn(async (command: any) => {
      spawnCommands.push(command);
      return { ok: true, snapshot: { ...snapshot } };
    }),
    waitUntilSettled: vi.fn(async () => {}),
    markResult: vi.fn(),
    getSnapshot: vi.fn(() => ({ ...snapshot })),
    listSnapshots: vi.fn(() => []),
    stop: vi.fn((id: string, initiator: string) => {
      stops.push({ id, initiator });
      return true;
    }),
  };
  return { manager, spawnCommands, stops, snapshot };
}

/** Scripted `git rev-parse --git-common-dir` probe keyed by cwd (external pi.exec port). */
function gitProbe(commonDirByCwd: Map<string, string | null>) {
  return vi.fn(async (cmd: string, args: string[], opts?: { cwd?: string }) => {
    if (cmd !== "git" || args[0] !== "rev-parse") {
      throw new Error(`Unexpected exec: ${cmd} ${args.join(" ")}`);
    }
    const dir = commonDirByCwd.get(opts?.cwd ?? "");
    if (dir === null || dir === undefined) {
      return { code: 128, stdout: "", stderr: "not a git repo" };
    }
    return { code: 0, stdout: `${dir}\n`, stderr: "" };
  });
}

const tempRoots: string[] = [];

/** Real directory under tmp; returned canonicalized because the validator compares realpaths. */
function makeTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempRoots.push(dir);
  return realpathSync(dir);
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp cleanup is best-effort */
    }
  }
});

/** The validator's public contract normalizes to forward slashes. */
function normalized(value: string): string {
  return value.replace(/\\/g, "/");
}

let routing: ModelAccessFragment;
let mgr: ReturnType<typeof stubManager>;
let forceBackground: boolean;
let agents: AgentRegistry;

/** Build the executor over an explicit composition-root record. */
function buildExecutor(options: { parentCwd?: string; exec?: (...args: any[]) => any } = {}) {
  mgr = stubManager();
  const pi = { sendMessage: vi.fn(), exec: options.exec ?? vi.fn() } as any;
  const runtime = fakeExtensionRuntime({
    pi,
    sessionCtx: { cwd: options.parentCwd ?? "/home/test/project" } as any,
    manager: mgr.manager as any,
    agents,
    // The real probe over the scripted exec port: the executor's early check
    // and the accepted spawn must resolve paths the same way.
    worktree: createFsWorktreeInspector(pi),
    agentSettings: {
      ...inertAgentSettings(),
      read: () => ({
        ...inertAgentSettings().read(),
        graceTurns: 5,
        forceBackground,
      }),
    },
    modelAccess: () => structuredClone(routing),
  });
  return createAgentToolExecutor(runtime);
}

beforeEach(() => {
  // Fresh built-in registry per test: discovery cases below add worktree-local
  // types and must not leak them into later tests.
  agents = testAgentRegistry();
  const missingRoot = join(tmpdir(), "tool-execution-no-agents");
  agents.setScanRoots(join(missingRoot, "user"), join(missingRoot, "project"));
  routing = disabledModelAccess();
  forceBackground = false;
});

function makeParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: "Do something useful",
    description: "Test agent",
    agent: "general-purpose",
    ...overrides,
  };
}

function makeModel(provider: string, id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider,
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("REQ-WORKTREE-001 executeAgentTool — worktree_path validation", () => {
  let ctx: any;
  let repo: string;
  let worktree: string;
  let commonDirs: Map<string, string | null>;
  let exec: ReturnType<typeof gitProbe>;
  let execute: ReturnType<typeof buildExecutor>;

  beforeEach(() => {
    ctx = fakeCtx();
    repo = makeTempDir("te-repo");
    worktree = makeTempDir("te-wt");
    commonDirs = new Map([
      [repo, join(repo, ".git")],
      [worktree, join(repo, ".git")],
    ]);
    exec = gitProbe(commonDirs);
    execute = buildExecutor({ parentCwd: repo, exec });
  });

  it("resolves worktree_path through git probes and forwards it to spawn", async () => {
    await execute("tc-1", makeParams({ worktree_path: worktree }), undefined, undefined, ctx);

    // One probe per side of the common-dir comparison: parent cwd and target.
    expect(exec).toHaveBeenCalledTimes(2);
    const probedCwds = exec.mock.calls.map((call) => call[2]?.cwd);
    expect(probedCwds).toEqual([repo, worktree]);

    expect(mgr.spawnCommands).toHaveLength(1);
    expect(mgr.spawnCommands[0].validatedWorktreePath).toBe(normalized(worktree));
    expect(mgr.spawnCommands[0]).not.toHaveProperty("parentCwd");
  });

  it("throws the validator error and does not spawn for a foreign worktree", async () => {
    commonDirs.set(worktree, join(worktree, ".git"));

    await expect(execute("tc-2", makeParams({ worktree_path: worktree }), undefined, undefined, ctx))
      .rejects.toThrow(WORKTREE_VALIDATION_ERRORS.DIFFERENT_REPO);
    expect(mgr.spawnCommands).toHaveLength(0);
  });

  it("throws filesystem rejections without invoking git", async () => {
    await expect(
      execute(
        "tc-missing",
        makeParams({ worktree_path: join(worktree, "missing") }),
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(WORKTREE_VALIDATION_ERRORS.PATH_DOES_NOT_EXIST);

    expect(exec).not.toHaveBeenCalled();
    expect(mgr.spawnCommands).toHaveLength(0);
  });

  it("flushes git-probe warnings via ctx.ui.notify on validation failure", async () => {
    execute = buildExecutor({
      parentCwd: repo,
      exec: vi.fn(async () => {
        throw new Error("EACCES permission denied");
      }),
    });
    ctx.ui = { notify: vi.fn() };

    await expect(execute("tc-warn", makeParams({ worktree_path: worktree }), undefined, undefined, ctx))
      .rejects.toThrow("git rev-parse failed: EACCES permission denied");
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      `[pi-subagents-lite] git rev-parse --git-common-dir failed in ${repo}: EACCES permission denied`,
      "warning",
    );
  });

  it("throws when the warning notifier itself throws", async () => {
    execute = buildExecutor({
      parentCwd: repo,
      exec: vi.fn(async () => {
        throw new Error("EACCES permission denied");
      }),
    });
    ctx.ui = {
      notify: vi.fn(() => {
        throw new Error("notifier exploded");
      }),
    };

    await expect(execute("tc-crash", makeParams({ worktree_path: worktree }), undefined, undefined, ctx))
      .rejects.toThrow("worktree_path validation failed: notifier exploded");
    expect(mgr.spawnCommands).toHaveLength(0);
  });

  it("does not probe git when worktree_path is omitted", async () => {
    await execute("tc-3", makeParams(), undefined, undefined, ctx);

    expect(exec).not.toHaveBeenCalled();
    expect(mgr.spawnCommands).toHaveLength(1);
    expect(mgr.spawnCommands[0].validatedWorktreePath).toBeUndefined();
  });

  it("does not lose a foreground abort while spawn is awaiting its snapshot", async () => {
    const controller = new AbortController();
    const spawned = makeResolvablePromise<any>();
    mgr.manager.execute.mockImplementation(async (command: any) => {
      mgr.spawnCommands.push(command);
      return spawned.promise;
    });

    const pending = execute("tc-fg-signal", makeParams(), controller.signal, undefined, ctx);
    controller.abort();
    expect(mgr.stops).toEqual([]);
    spawned.resolve({ ok: true, snapshot: { ...mgr.snapshot } });
    await pending;

    expect(mgr.stops).toEqual([{ id: "agent-id-123", initiator: "user" }]);
    expect(mgr.spawnCommands[0].parentAborted).toBe(false);
  });

  it("stops after the agent ID exists while foreground settlement is pending", async () => {
    const controller = new AbortController();
    const settled = makeResolvablePromise<void>();
    mgr.manager.waitUntilSettled.mockReturnValue(settled.promise);

    const pending = execute("tc-fg-running-signal", makeParams(), controller.signal, undefined, ctx);
    await vi.waitFor(() => expect(mgr.manager.waitUntilSettled).toHaveBeenCalledWith("agent-id-123"));
    controller.abort();

    expect(mgr.stops).toEqual([{ id: "agent-id-123", initiator: "user" }]);
    settled.resolve(undefined);
    await pending;
  });

  it("removes the foreground abort listener when spawn rejects", async () => {
    const controller = new AbortController();
    mgr.manager.execute.mockRejectedValue(new Error("spawn rejected"));

    await expect(execute(
      "tc-fg-rejected",
      makeParams(),
      controller.signal,
      undefined,
      ctx,
    )).rejects.toThrow("spawn rejected");
    controller.abort();

    expect(mgr.stops).toEqual([]);
  });

  it("removes the foreground abort listener after settlement and never links background work", async () => {
    let controller = new AbortController();
    await execute("tc-fg-settled", makeParams(), controller.signal, undefined, ctx);
    controller.abort();
    expect(mgr.stops).toEqual([]);

    controller = new AbortController();
    execute = buildExecutor();
    await execute("tc-bg-signal", makeParams({ run_in_background: true }), controller.signal, undefined, ctx);
    controller.abort();
    expect(mgr.stops).toEqual([]);

    controller = new AbortController();
    forceBackground = true;
    execute = buildExecutor();
    await execute("tc-forced-bg-signal", makeParams(), controller.signal, undefined, ctx);
    controller.abort();
    expect(mgr.stops).toEqual([]);
  });

  it("stops an already-aborted foreground call after the snapshot acquires an ID", async () => {
    const controller = new AbortController();
    controller.abort();

    await execute("tc-fg-already-aborted", makeParams(), controller.signal, undefined, ctx);

    expect(mgr.spawnCommands[0].parentAborted).toBe(true);
    expect(mgr.stops).toEqual([{ id: "agent-id-123", initiator: "user" }]);
  });

});

describe("REQ-AGENT-001 executeAgentTool — spawn inputs and outcome", () => {
  let ctx: any;
  let execute: ReturnType<typeof buildExecutor>;

  beforeEach(() => {
    ctx = fakeCtx();
    execute = buildExecutor();
  });

  it("accepts the documented spawn inputs and forwards them as one spawn command", async () => {
    const result = await execute(
      "tc-inputs",
      makeParams({ prompt: "Review the diff", description: "Reviewer run", run_in_background: false }),
      undefined,
      undefined,
      ctx,
    );

    expect(mgr.spawnCommands).toHaveLength(1);
    expect(mgr.spawnCommands[0]).toMatchObject({
      kind: "spawn",
      type: "general-purpose",
      description: "Reviewer run",
      prompt: "Review the diff",
    });
    // Background vs foreground is a host scheduling choice; the runtime
    // command must not carry it or additionalProperties: false rejects spawn.
    expect(mgr.spawnCommands[0]).not.toHaveProperty("runInBackground");
    expect(result.isError).toBeUndefined();
  });

  it("returns the recorded snapshot result for completed foreground agents", async () => {
    const result = await execute("tc-ok", makeParams(), undefined, undefined, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Agent completed successfully");
  });

  it("returns the recorded failure diagnostic for foreground agents", async () => {
    mgr.snapshot.status = "error";
    mgr.snapshot.result = "";
    mgr.snapshot.error = "503 service_unavailable";

    const result = await execute("tc-error", makeParams(), undefined, undefined, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Agent failed: 503 service_unavailable");
  });

  it("rejects an unknown agent type without reaching the scheduler", async () => {
    await expect(execute("tc-unknown", makeParams({ agent: "no-such-type" }), undefined, undefined, ctx))
      .rejects.toThrow("Unknown agent type: no-such-type");
    expect(mgr.spawnCommands).toHaveLength(0);
  });
});

describe("executeAgentTool — worktree_path with background spawn", () => {
  let ctx: any;
  let repo: string;
  let worktree: string;
  let execute: ReturnType<typeof buildExecutor>;

  beforeEach(() => {
    ctx = fakeCtx();
    repo = makeTempDir("te-bg-repo");
    worktree = makeTempDir("te-bg-wt");
    const commonDirs = new Map([
      [repo, join(repo, ".git")],
      [worktree, join(repo, ".git")],
    ]);
    execute = buildExecutor({ parentCwd: repo, exec: gitProbe(commonDirs) });
  });

  it("validates worktree_path for background spawns too", async () => {
    mgr.snapshot.status = "running";
    mgr.snapshot.result = undefined;

    const result = await execute(
      "tc-bg",
      makeParams({ worktree_path: worktree, run_in_background: true }),
      undefined,
      undefined,
      ctx,
    );

    expect(mgr.spawnCommands).toHaveLength(1);
    expect(mgr.spawnCommands[0].validatedWorktreePath).toBe(normalized(worktree));
    // Background spawns anchor delivery to the parent session; nothing else
    // (no model key, no delivery handle) may ride along in the command.
    expect(mgr.spawnCommands[0].resultSessionId).toBe("parent-session");
    expect(mgr.spawnCommands[0].resultOriginEntryId).toBe("leaf-entry");
    expect(mgr.spawnCommands[0]).not.toHaveProperty("modelKey");
    expect(mgr.spawnCommands[0]).not.toHaveProperty("backgroundDelivery");
    expect(result.content[0].text).toContain("[Agent running]");
    expect(result.content[0].text).toContain("delivered automatically");
  });

  it("throws for invalid worktree_path in background spawn", async () => {
    await expect(
      execute(
        "tc-bg-err",
        makeParams({ worktree_path: join(worktree, "gone"), run_in_background: true }),
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(WORKTREE_VALIDATION_ERRORS.PATH_DOES_NOT_EXIST);
    expect(mgr.spawnCommands).toHaveLength(0);
  });
});

describe("executeAgentTool — worktree_path discovery integration", () => {
  let ctx: any;
  let repo: string;
  let worktree: string;
  let execute: ReturnType<typeof buildExecutor>;

  beforeEach(() => {
    ctx = fakeCtx();
    repo = makeTempDir("te-disc-repo");
    worktree = makeTempDir("te-disc-wt");
    const commonDirs = new Map([
      [repo, join(repo, ".git")],
      [worktree, join(repo, ".git")],
    ]);
    execute = buildExecutor({ parentCwd: repo, exec: gitProbe(commonDirs) });
  });

  it("asks discovery to scan the worktree path named by config-paths", async () => {
    const discoverNew = vi.spyOn(agents, "discoverNew");

    await expect(
      execute(
        "tc-disc-path",
        makeParams({ agent: "feature-reviewer", worktree_path: worktree }),
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("Unknown agent type: feature-reviewer");

    expect(discoverNew).toHaveBeenCalledWith(projectAgentsDirPath(normalized(worktree)));
  });

  it("discovers a worktree-local agent type on demand", async () => {
    const agentDir = join(worktree, ".pi", "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "feature-reviewer.md"),
      makeAgentMd({ name: "feature-reviewer", display_name: "Feature Reviewer" }),
    );

    const result = await execute(
      "tc-disc",
      makeParams({ agent: "feature-reviewer", worktree_path: worktree }),
      undefined,
      undefined,
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(mgr.spawnCommands).toHaveLength(1);
    expect(mgr.spawnCommands[0].type).toBe("feature-reviewer");
  });

  it("throws an unknown type when discovery without a worktree finds nothing", async () => {
    await expect(
      execute(
        "tc-disc-no-wt",
        makeParams({ agent: "feature-reviewer" }),
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("Unknown agent type: feature-reviewer");
    expect(mgr.spawnCommands).toHaveLength(0);
  });
});

describe("executeAgentTool — thinking param", () => {
  let ctx: any;
  let execute: ReturnType<typeof buildExecutor>;

  beforeEach(() => {
    ctx = fakeCtx();
    ctx.model = { ...ctx.model, reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } };
    ctx.thinkingLevel = "medium";
    execute = buildExecutor();
  });

  it("forwards explicitly allowed thinking=low to spawn", async () => {
    await execute("tc-think", makeParams({ thinking: "low" }), undefined, undefined, ctx);

    expect(mgr.spawnCommands).toHaveLength(1);
    expect(mgr.spawnCommands[0].acceptedPolicy.thinkingLevel).toBe("low");
  });

  it("rejects free-form thinking values not in Pi's canonical list", async () => {
    await expect(execute("tc-think-custom", makeParams({ thinking: "super-high" }), undefined, undefined, ctx))
      .rejects.toThrow("Allowed thinking levels");
    expect(mgr.spawnCommands).toHaveLength(0);
  });
});

describe("executeAgentTool — model access", () => {
  let ctx: any;
  let execute: ReturnType<typeof buildExecutor>;

  beforeEach(() => {
    routing = {
      enabled: true,
      enabledProviders: ["cpa-responses"],
      agentAccess: {
        "general-purpose": { providers: { "cpa-responses": { models: ["grok-4.5"] } } },
      },
    };
    ctx = fakeCtx();
    ctx.thinkingLevel = "medium";
    ctx.model = makeModel("test", "parent-model", {
      thinkingLevelMap: { xhigh: "xhigh", max: null },
    });
    const models = [
      ctx.model,
      makeModel("test", "other-model"),
      makeModel("cpa-responses", "grok-4.5", { thinkingLevelMap: { xhigh: "xhigh", max: null } }),
      makeModel("cpa-responses", "grok-5"),
    ];
    ctx.modelRegistry = {
      find: vi.fn((provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id)),
      getAll: vi.fn(() => models),
      getAvailable: vi.fn(() => models),
    };
    ctx.scopedModels = [];
    execute = buildExecutor();
  });

  it("uses the exact parent when model is omitted and Parent access is implicit", async () => {
    await execute("parent", makeParams({ model: undefined }), undefined, undefined, ctx);
    expect(mgr.spawnCommands[0].acceptedPolicy.model).toEqual(ctx.model);
    expect(mgr.spawnCommands[0].acceptedPolicy.thinkingLevel).toBe("medium");
  });

  it("rejects omitted and explicit Parent default use when Parent access is denied", async () => {
    routing.agentAccess["general-purpose"].parentModelAccess = false;

    await expect(execute("parent-denied-omitted", makeParams({ model: undefined }), undefined, undefined, ctx))
      .rejects.toThrow("parent model");

    await expect(
      execute(
        "parent-denied-explicit",
        makeParams({ model: "test/parent-model" }),
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("parent model");
    expect(mgr.spawnCommands).toHaveLength(0);
  });

  it("allows the exact parent explicitly while routing is OFF", async () => {
    routing.enabled = false;
    await execute("parent-explicit", makeParams({ model: "test/parent-model" }), undefined, undefined, ctx);
    expect(mgr.spawnCommands).toHaveLength(1);
  });

  it("uses the accepted parent object even when it is absent from the registry", async () => {
    routing.enabled = false;
    ctx.modelRegistry.find.mockReturnValue(undefined);
    ctx.modelRegistry.getAll.mockReturnValue([]);
    ctx.modelRegistry.getAvailable.mockReturnValue([]);
    await execute("parent-unregistered", makeParams({ model: "test/parent-model" }), undefined, undefined, ctx);
    expect(mgr.spawnCommands[0].acceptedPolicy.model).toEqual(ctx.model);
    expect(mgr.spawnCommands[0].acceptedPolicy.model).not.toBe(ctx.model);
  });

  it("rejects every non-parent explicit model while routing is OFF", async () => {
    routing.enabled = false;
    await expect(execute("off", makeParams({ model: "test/other-model" }), undefined, undefined, ctx))
      .rejects.toThrow("Alternate models are OFF");
    expect(mgr.spawnCommands).toHaveLength(0);
  });

  it("requires a parent only when model is omitted", async () => {
    ctx.model = undefined;
    await expect(execute("missing-parent", makeParams({ model: undefined }), undefined, undefined, ctx))
      .rejects.toThrow("parent session has no active model");

    await execute("explicit-no-parent", makeParams({ model: "cpa-responses/grok-4.5" }), undefined, undefined, ctx);
    expect(mgr.spawnCommands).toHaveLength(1);
  });

  it("requires the provider to be globally enabled", async () => {
    routing.enabledProviders = [];
    await expect(execute("provider", makeParams({ model: "cpa-responses/grok-4.5" }), undefined, undefined, ctx))
      .rejects.toThrow('provider "cpa-responses" is disabled');
  });

  it("does not bypass explicit Provider access for current-parent-provider alternates", async () => {
    routing.enabledProviders = [];
    routing.agentAccess = {
      "general-purpose": { providers: { test: { models: ["other-model"] } } },
    };
    await expect(execute("parent-provider-alternate", makeParams({ model: "test/other-model" }), undefined, undefined, ctx))
      .rejects.toThrow('provider "test" is disabled');
    expect(mgr.spawnCommands).toHaveLength(0);

    routing.enabledProviders = ["test"];
    await execute("parent-provider-enabled", makeParams({ model: "test/other-model" }), undefined, undefined, ctx);
    expect(mgr.spawnCommands).toHaveLength(1);
  });

  it("applies policy gates before registry availability for qualified models", async () => {
    routing.enabledProviders = [];
    await expect(execute("unknown-provider", makeParams({ model: "missing/worker" }), undefined, undefined, ctx))
      .rejects.toThrow('provider "missing" is disabled');
  });

  it("requires an Agent/provider rule", async () => {
    routing.agentAccess = {};
    await expect(execute("agent-provider", makeParams({ model: "cpa-responses/grok-4.5" }), undefined, undefined, ctx))
      .rejects.toThrow("has no access rule");
  });

  it("requires a matching exact model rule", async () => {
    await expect(execute("model-rule", makeParams({ model: "cpa-responses/grok-5" }), undefined, undefined, ctx))
      .rejects.toThrow("not authorized by the saved model access rule");
  });

  it("allows an all-model rule", async () => {
    routing.agentAccess["general-purpose"].providers["cpa-responses"] = {};
    await execute("all", makeParams({ model: "cpa-responses/grok-5" }), undefined, undefined, ctx);
    expect(mgr.spawnCommands).toHaveLength(1);
  });

  it("rejects catalogue-only alternate models", async () => {
    ctx.modelRegistry.getAvailable = vi.fn(() => [{ provider: "test", id: "parent-model" }]);
    await expect(execute("availability", makeParams({ model: "cpa-responses/grok-4.5" }), undefined, undefined, ctx))
      .rejects.toThrow("not currently available to Pi");
    expect(mgr.spawnCommands).toHaveLength(0);
  });

  it("rejects alternate models outside active scope", async () => {
    ctx.scopedModels = [{ model: makeModel("test", "parent-model") }];
    await expect(execute("scope", makeParams({ model: "cpa-responses/grok-4.5" }), undefined, undefined, ctx))
      .rejects.toThrow("active model scope");
    expect(mgr.spawnCommands).toHaveLength(0);
  });

  it("rejects bare model IDs", async () => {
    await expect(execute("bare", makeParams({ model: "grok-4.5" }), undefined, undefined, ctx))
      .rejects.toThrow("provider/model");
    expect(mgr.spawnCommands).toHaveLength(0);
  });

  it("rejects the retired model:thinking shorthand", async () => {
    await expect(execute("shorthand", makeParams({ model: "cpa-responses/grok-4.5:low" }), undefined, undefined, ctx))
      .rejects.toThrow();
    expect(mgr.spawnCommands).toHaveLength(0);
  });

  it("locks model, scope, and resolved thinking in the spawn command", async () => {
    ctx.scopedModels = [{ model: makeModel("cpa-responses", "grok-4.5"), thinkingLevel: "high" }];
    await execute("snapshot", makeParams({ model: "cpa-responses/grok-4.5" }), undefined, undefined, ctx);

    const acceptedPolicy = mgr.spawnCommands[0].acceptedPolicy;
    expect(acceptedPolicy.model).toMatchObject({ provider: "cpa-responses", id: "grok-4.5" });
    expect(acceptedPolicy.scopedModels).toEqual(ctx.scopedModels);
    expect(acceptedPolicy.thinkingLevel).toBe("high");
    expect(mgr.spawnCommands[0].invocation.thinkingLevel).toBe("high");
  });

  it("accepts Pi 0.84.1 composed models that still carry undefined keys and host extras", async () => {
    ctx.model = makeModel("cpa-responses", "grok-4.5", {
      thinkingLevelMap: { xhigh: "xhigh", max: "max", ultra: "ultra" },
      samplingParams: undefined,
      headers: undefined,
      compat: undefined,
      source: "models_json",
    });
    ctx.scopedModels = [
      { model: ctx.model, thinkingLevel: undefined },
      { model: makeModel("test", "parent-model"), thinkingLevel: "high" },
    ];
    ctx.modelRegistry.getAvailable = vi.fn(() => [ctx.model, makeModel("test", "parent-model")]);

    const result = await execute("pi-runtime-model", makeParams({ model: undefined }), undefined, undefined, ctx);

    expect(result.isError).toBeUndefined();
    expect(mgr.spawnCommands).toHaveLength(1);
    expect(mgr.spawnCommands[0].acceptedPolicy.model).toMatchObject({
      provider: "cpa-responses",
      id: "grok-4.5",
    });
    expect(mgr.spawnCommands[0].acceptedPolicy.model).not.toHaveProperty("source");
    expect(mgr.spawnCommands[0].acceptedPolicy.model).not.toHaveProperty("headers");
    expect(mgr.spawnCommands[0].acceptedPolicy.scopedModels[0]).toEqual({
      model: expect.not.objectContaining({ source: "models_json" }),
    });
    expect(mgr.spawnCommands[0].acceptedPolicy.scopedModels[0]).not.toHaveProperty("thinkingLevel");
  });

  it("names the failing accepted-policy field instead of a bare invalid-policy sentence", async () => {
    ctx.model = makeModel("cpa-responses", "grok-4.5", { maxTokens: 0 });
    ctx.modelRegistry.getAvailable = vi.fn(() => [ctx.model]);

    await expect(execute("invalid-policy-detail", makeParams({ model: undefined }), undefined, undefined, ctx))
      .rejects.toThrow(/produced an invalid accepted run policy[\s\S]*(outputTokenLimit|maxTokens|exclusiveMinimum)/);
    expect(mgr.spawnCommands).toHaveLength(0);
  });

  it("makes a Model scope thinking pin authoritative", async () => {
    ctx.scopedModels = [{ model: makeModel("cpa-responses", "grok-4.5"), thinkingLevel: "medium" }];
    await expect(
      execute(
        "thinking",
        makeParams({ model: "cpa-responses/grok-4.5", thinking: "xhigh" }),
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("medium");
    expect(mgr.spawnCommands).toHaveLength(0);

    await execute("thinking-default", makeParams({ model: "cpa-responses/grok-4.5" }), undefined, undefined, ctx);
    expect(mgr.spawnCommands[0].acceptedPolicy.thinkingLevel).toBe("medium");
  });

  it("uses an exact-model thinking allowlist and default", async () => {
    routing.agentAccess["general-purpose"].thinking = {
      "cpa-responses/grok-4.5": {
        allowed: ["low", "medium"],
        default: "low",
      },
    };
    await execute("thinking-default", makeParams({ model: "cpa-responses/grok-4.5" }), undefined, undefined, ctx);
    expect(mgr.spawnCommands[0].acceptedPolicy.thinkingLevel).toBe("low");

    execute = buildExecutor();
    await expect(
      execute(
        "thinking-denied",
        makeParams({ model: "cpa-responses/grok-4.5", thinking: "high" }),
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/low[\s\S]*medium|medium[\s\S]*low/);
    expect(mgr.spawnCommands).toHaveLength(0);
  });

  it("defaults an alternate model from Pi's high normalization", async () => {
    await execute("alternate-default", makeParams({ model: "cpa-responses/grok-4.5" }), undefined, undefined, ctx);
    expect(mgr.spawnCommands[0].acceptedPolicy.thinkingLevel).toBe("high");
  });

  it("never falls back after an explicit denial", async () => {
    await expect(execute("no-fallback", makeParams({ model: "cpa-responses/grok-5" }), undefined, undefined, ctx))
      .rejects.toThrow();
    expect(mgr.spawnCommands).toHaveLength(0);
  });
});
