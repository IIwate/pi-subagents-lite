import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { acceptedRunPolicy } from "../../fixtures.ts";
import {
  AgentCommandResultSchema,
  AgentSnapshotSchema,
  createSubagentRuntime,
  DEFAULT_RETENTION_MS,
  type AgentSnapshot,
  type SessionDriver,
  type SessionEvent,
  type SessionInspectResult,
  type SessionStartRequest,
  type WorktreeInspector,
} from "../../../src/modules/subagent-runtime/public.js";

interface MemoryRun {
  request: SessionStartRequest;
  emit: (event: SessionEvent) => void;
  resolve: () => void;
  reject: (error: Error) => void;
}

function createMemoryDriver() {
  const runs = new Map<string, MemoryRun>();
  const continues = new Map<string, MemoryRun>();
  const steers: Array<{ sessionId: string; message: string; images?: unknown[] }> = [];
  const aborts: string[] = [];
  const closes: string[] = [];
  const sessions = new Map<string, {
    live: boolean;
    streaming: boolean;
    modelId?: string;
    provider?: string;
    thinkingLevel?: SessionInspectResult["thinkingLevel"];
    messages: unknown[];
  }>();

  const driver: SessionDriver = {
    start(request, emit) {
      emit({ type: "setup-started", agentId: request.agentId, sessionId: request.sessionId });
      emit({ type: "setup-finished", agentId: request.agentId, sessionId: request.sessionId });
      emit({
        type: "session-ready",
        agentId: request.agentId,
        sessionId: request.sessionId,
        modelId: request.acceptedPolicy.model.id,
        provider: request.acceptedPolicy.model.provider,
      });
      sessions.set(request.sessionId, {
        live: true,
        streaming: true,
        modelId: request.acceptedPolicy.model.id,
        provider: request.acceptedPolicy.model.provider,
        messages: [],
      });
      return new Promise<void>((resolve, reject) => {
        runs.set(request.agentId, {
          request,
          emit,
          resolve: () => {
            const session = sessions.get(request.sessionId);
            if (session) session.streaming = false;
            resolve();
          },
          reject,
        });
      });
    },
    continueRun(request, emit) {
      const session = sessions.get(request.sessionId);
      if (session) session.streaming = true;
      return new Promise<void>((resolve, reject) => {
        continues.set(request.agentId, {
          request: {
            agentId: request.agentId,
            sessionId: request.sessionId,
            agentType: "continued",
            prompt: request.prompt,
            acceptedPolicy: acceptedRunPolicy("test/model"),
          },
          emit,
          resolve: () => {
            if (session) session.streaming = false;
            resolve();
          },
          reject,
        });
      });
    },
    async steer(request) {
      if (!sessions.get(request.sessionId)?.live) return { accepted: false };
      steers.push(request);
      return { accepted: true };
    },
    async abort(request) {
      aborts.push(request.sessionId);
    },
    async close(request) {
      closes.push(request.sessionId);
      const session = sessions.get(request.sessionId);
      if (session) session.live = false;
    },
    inspect(request) {
      const session = sessions.get(request.sessionId);
      if (!session) return { found: false, live: false, streaming: false, messages: [] };
      return {
        found: true,
        live: session.live,
        streaming: session.streaming,
        modelId: session.modelId,
        provider: session.provider,
        thinkingLevel: session.thinkingLevel,
        messages: session.messages,
      };
    },
  };

  return { driver, runs, continues, steers, aborts, closes, sessions };
}

function createClock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) { now += ms; },
  };
}

function createIds(prefix = "agent") {
  let count = 0;
  return {
    nextId: () => {
      count += 1;
      return `${prefix}-${String(count).padStart(8, "0")}`;
    },
  };
}

const acceptingWorktree: WorktreeInspector = {
  async inspect(request) {
    return { ok: true, resolvedPath: `/resolved${request.worktreePath}` };
  },
};

function createRuntime(
  driver: SessionDriver,
  overrides?: {
    clock?: { now(): number };
    limits?: { defaultModelLimit: number; modelLimits: Record<string, number>; providerLimits: Record<string, number> };
    worktree?: WorktreeInspector;
  },
) {
  return createSubagentRuntime({
    sessionDriver: driver,
    worktreeInspector: overrides?.worktree ?? acceptingWorktree,
    clock: overrides?.clock ?? { now: () => 1_000 },
    ids: createIds(),
    scheduler: {
      interval: () => ({ clear() {} }),
      timeout: () => ({ clear() {} }),
    },
    limits: overrides?.limits ?? {
      defaultModelLimit: 4,
      modelLimits: {},
      providerLimits: {},
    },
  });
}

async function completeRun(
  memory: ReturnType<typeof createMemoryDriver>,
  id: string,
  fields?: Partial<Extract<SessionEvent, { type: "completed" }>>,
): Promise<void> {
  const run = memory.runs.get(id);
  if (!run) throw new Error(`missing run ${id}`);
  run.emit({
    type: "completed",
    agentId: id,
    sessionId: id,
    responseText: "done",
    aborted: false,
    turnLimited: false,
    ...fields,
  });
  run.resolve();
  await Promise.resolve();
}

describe("REQ-RUNTIME-002 lifecycle public seam", () => {
  it("spawns, queues, stops, and inspects without a Pi session object", async () => {
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver, {
      limits: {
        defaultModelLimit: 1,
        modelLimits: { "llamacpp/4b_small": 1 },
        providerLimits: {},
      },
    });

    const first = await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "task 1",
      description: "task 1",
      acceptedPolicy: acceptedRunPolicy("llamacpp/4b_small"),
    });
    const second = await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "task 2",
      description: "task 2",
      acceptedPolicy: acceptedRunPolicy("llamacpp/4b_small"),
    });

    expect(Check(AgentCommandResultSchema, first)).toBe(true);
    expect(Check(AgentCommandResultSchema, second)).toBe(true);
    expect(first).toMatchObject({ ok: true, snapshot: { status: "running", id: "agent-00000001" } });
    expect(second).toMatchObject({ ok: true, snapshot: { status: "queued", id: "agent-00000002" } });
    expect(memory.runs.has("agent-00000001")).toBe(true);
    expect(memory.runs.has("agent-00000002")).toBe(false);

    const listed = await runtime.execute({ kind: "inspect" });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.snapshots?.map((snapshot) => `${snapshot.id}:${snapshot.status}`).sort()).toEqual([
      "agent-00000001:running",
      "agent-00000002:queued",
    ]);

    const stopped = await runtime.execute({
      kind: "stop",
      id: "agent-00000002",
      initiator: "agent",
    });
    expect(stopped).toMatchObject({
      ok: true,
      stopped: true,
      snapshot: { id: "agent-00000002", status: "stopped", settled: true, stoppedBy: "agent" },
    });

    await completeRun(memory, "agent-00000001");
    const settled = await runtime.waitUntilSettled("agent-00000001");
    expect(Check(AgentSnapshotSchema, settled)).toBe(true);
    expect(settled).toMatchObject({
      id: "agent-00000001",
      status: "completed",
      result: "done",
      settled: true,
    });
  });

  it("rejects a worktree target through the inspector port", async () => {
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver, {
      worktree: {
        async inspect() {
          return { ok: false, error: "worktree_path is not a worktree of the parent's repository" };
        },
      },
    });

    const result = await runtime.execute({
      kind: "spawn",
      type: "Explore",
      prompt: "look",
      description: "look",
      acceptedPolicy: acceptedRunPolicy("test/model"),
      worktreePath: "../other-repo",
      parentCwd: "/repo",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "worktree-invalid",
        message: "worktree_path is not a worktree of the parent's repository",
      },
    });
    expect(runtime.listSnapshots()).toEqual([]);
  });
});

describe("REQ-RUNTIME-001 queue release", () => {
  it("starts the queued snapshot only after the reserved run settles", async () => {
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver, {
      limits: { defaultModelLimit: 1, modelLimits: {}, providerLimits: {} },
    });

    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "one",
      description: "one",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "two",
      description: "two",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });

    expect(runtime.getSnapshot("agent-00000002")?.status).toBe("queued");
    await completeRun(memory, "agent-00000001");
    await Promise.resolve();
    expect(runtime.getSnapshot("agent-00000002")?.status).toBe("running");
    expect(memory.runs.has("agent-00000002")).toBe(true);
  });

  it("releases a reserved slot and starts the queue when the occupant is closed", async () => {
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver, {
      limits: { defaultModelLimit: 1, modelLimits: {}, providerLimits: {} },
    });

    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "one",
      description: "one",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "two",
      description: "two",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });

    expect(runtime.getSnapshot("agent-00000002")?.status).toBe("queued");
    expect(await runtime.execute({ kind: "close", id: "agent-00000001", initiator: "user" })).toEqual({
      ok: true,
      closed: true,
    });
    await Promise.resolve();
    expect(runtime.getSnapshot("agent-00000001")).toBeUndefined();
    expect(runtime.getSnapshot("agent-00000002")?.status).toBe("running");
    expect(memory.runs.has("agent-00000002")).toBe(true);
  });
});

describe("REQ-RUNTIME-003 foreground interruption", () => {
  it("stops an already-aborted spawn before the session driver starts", async () => {
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver);
    const result = await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "task",
      description: "task",
      acceptedPolicy: acceptedRunPolicy("test/model"),
      parentAborted: true,
    });

    expect(result).toMatchObject({
      ok: true,
      snapshot: { status: "stopped", settled: true, stoppedBy: "user" },
    });
    expect(memory.runs.size).toBe(0);
  });

  it("aborts a session that becomes ready after stop", async () => {
    const aborts: string[] = [];
    const steers: string[] = [];
    let emitReady: ((event: SessionEvent) => void) | undefined;
    let resolveStart: (() => void) | undefined;
    const driver: SessionDriver = {
      start(request, emit) {
        emit({ type: "setup-started", agentId: request.agentId, sessionId: request.sessionId });
        emit({ type: "setup-finished", agentId: request.agentId, sessionId: request.sessionId });
        emitReady = emit;
        return new Promise<void>((resolve) => { resolveStart = resolve; });
      },
      async continueRun() {},
      async steer(request) {
        steers.push(request.sessionId);
        return { accepted: true };
      },
      async abort(request) { aborts.push(request.sessionId); },
      async close() {},
      inspect() { return { found: false, live: false, streaming: false, messages: [] }; },
    };
    const runtime = createRuntime(driver);

    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "task",
      description: "task",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    await runtime.execute({ kind: "interact", id: "agent-00000001", message: "too early" });
    expect(await runtime.execute({ kind: "stop", id: "agent-00000001", initiator: "user" })).toMatchObject({
      ok: true,
      stopped: true,
      snapshot: { status: "stopped" },
    });

    emitReady?.({
      type: "session-ready",
      agentId: "agent-00000001",
      sessionId: "agent-00000001",
      modelId: "model",
      provider: "test",
    });
    resolveStart?.();
    await Promise.resolve();

    expect(aborts).toEqual(["agent-00000001"]);
    expect(steers).toEqual([]);
    expect(runtime.getSnapshot("agent-00000001")?.status).toBe("stopped");
  });
});

describe("REQ-RUNTIME-004 retention and pinning", () => {
  it("expires only consumed terminal snapshots after the retention window", async () => {
    const clock = createClock();
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver, { clock });
    const removed: string[] = [];
    runtime.setOnRemove((snapshot) => { removed.push(snapshot.id); });

    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "keep",
      description: "keep",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "drop",
      description: "drop",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    await completeRun(memory, "agent-00000001");
    await completeRun(memory, "agent-00000002");
    await runtime.execute({ kind: "mark-result", id: "agent-00000002", consumed: true });

    clock.advance(DEFAULT_RETENTION_MS + 1);
    const expired = await runtime.execute({ kind: "expire" });
    expect(expired).toEqual({ ok: true, expiredIds: ["agent-00000002"] });
    expect(runtime.getSnapshot("agent-00000001")).toMatchObject({ id: "agent-00000001" });
    expect(runtime.getSnapshot("agent-00000002")).toBeUndefined();
    expect(removed).toEqual(["agent-00000002"]);
    expect(memory.closes).toEqual(["agent-00000002"]);
  });

  it("pauses cleanup while pinned and resumes the remaining window", async () => {
    const clock = createClock();
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver, { clock });

    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "pin",
      description: "pin",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    await completeRun(memory, "agent-00000001");
    await runtime.execute({ kind: "mark-result", id: "agent-00000001", consumed: true });
    expect(await runtime.execute({ kind: "pin", id: "agent-00000001" })).toMatchObject({
      ok: true,
      pinned: true,
    });

    clock.advance(DEFAULT_RETENTION_MS * 2);
    await runtime.execute({ kind: "expire" });
    expect(runtime.getSnapshot("agent-00000001")).toBeDefined();

    expect(await runtime.execute({ kind: "pin", id: "agent-00000001" })).toMatchObject({
      ok: true,
      pinned: false,
    });
    clock.advance(DEFAULT_RETENTION_MS);
    await runtime.execute({ kind: "expire" });
    expect(runtime.getSnapshot("agent-00000001")).toBeDefined();
    clock.advance(1);
    await runtime.execute({ kind: "expire" });
    expect(runtime.getSnapshot("agent-00000001")).toBeUndefined();
  });
});

describe("REQ-RUNTIME-005 continuation and interaction", () => {
  it("steers a live run and continues a settled session", async () => {
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver, {
      limits: { defaultModelLimit: 1, modelLimits: {}, providerLimits: {} },
    });

    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "task",
      description: "task",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });

    const steered = await runtime.execute({
      kind: "interact",
      id: "agent-00000001",
      message: "new direction",
    });
    expect(steered).toMatchObject({ ok: true, interaction: { accepted: true } });
    expect(memory.steers).toEqual([
      { sessionId: "agent-00000001", message: "new direction" },
    ]);

    await completeRun(memory, "agent-00000001");
    const continued = await runtime.execute({
      kind: "interact",
      id: "agent-00000001",
      message: "follow up",
    });
    expect(continued).toMatchObject({
      ok: true,
      interaction: { accepted: true },
      snapshot: { status: "running", settled: false },
    });

    const blocked = await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "other",
      description: "other",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    expect(blocked).toMatchObject({ ok: true, snapshot: { status: "queued" } });

    const continueRun = memory.continues.get("agent-00000001");
    continueRun?.emit({
      type: "completed",
      agentId: "agent-00000001",
      sessionId: "agent-00000001",
      responseText: "again",
      aborted: false,
      turnLimited: false,
    });
    continueRun?.resolve();
    const after = await runtime.waitUntilSettled("agent-00000001");
    expect(after).toMatchObject({ status: "completed", result: "again", resultConsumed: true });
    expect(runtime.getSnapshot("agent-00000002")?.status).toBe("running");
  });

  it("rejects interaction with a queued snapshot", async () => {
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver, {
      limits: { defaultModelLimit: 1, modelLimits: {}, providerLimits: {} },
    });
    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "one",
      description: "one",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "two",
      description: "two",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });

    const result = await runtime.execute({
      kind: "interact",
      id: "agent-00000002",
      message: "nudge",
    });
    expect(result).toMatchObject({ ok: true, interaction: { accepted: false, reason: "queued" } });
  });
});

describe("REQ-RUNTIME-006 shutdown", () => {
  it("closes a snapshot and ignores later driver completion", async () => {
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver);
    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "task",
      description: "task",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    const closed = await runtime.execute({ kind: "close", id: "agent-00000001", initiator: "user" });
    expect(closed).toEqual({ ok: true, closed: true });
    expect(runtime.getSnapshot("agent-00000001")).toBeUndefined();
    await completeRun(memory, "agent-00000001");
    expect(runtime.getSnapshot("agent-00000001")).toBeUndefined();
    expect(memory.aborts).toEqual(["agent-00000001"]);
    expect(memory.closes).toEqual(["agent-00000001"]);
  });
});

describe("REQ-RUNTIME-007 debug provenance", () => {
  it("consumes an armed fault on the next start, not while queued", async () => {
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver, {
      limits: { defaultModelLimit: 1, modelLimits: {}, providerLimits: {} },
    });
    await runtime.execute({ kind: "arm-debug-fault", fault: "provider_error" });
    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "one",
      description: "one",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "two",
      description: "two",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });

    expect(memory.runs.get("agent-00000001")?.request.debugFault).toBe("provider_error");
    expect(runtime.getSnapshot("agent-00000002")?.debugFaultKind).toBeUndefined();
    expect(runtime.debugDiagnostics().armedFault).toBeUndefined();

    await completeRun(memory, "agent-00000001");
    await Promise.resolve();
    expect(memory.runs.get("agent-00000002")?.request.debugFault).toBeUndefined();
  });
});

describe("session-driver contract", () => {
  it("covers setup, progress, completion, error, abort, continuation, and close", async () => {
    const events: SessionEvent[] = [];
    const memory = createMemoryDriver();
    const originalStart = memory.driver.start.bind(memory.driver);
    memory.driver.start = async (request, emit) => {
      const tracked = (event: SessionEvent) => {
        events.push(event);
        emit(event);
      };
      return originalStart(request, tracked);
    };

    const runtime = createRuntime(memory.driver);
    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "task",
      description: "task",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });

    const run = memory.runs.get("agent-00000001");
    run?.emit({
      type: "progress",
      agentId: "agent-00000001",
      sessionId: "agent-00000001",
      toolUse: true,
      usage: { input: 3, output: 2, cacheWrite: 1, cost: 0.5 },
      turnCount: 2,
    });
    await completeRun(memory, "agent-00000001", { responseText: "ok" });

    const completed = runtime.getSnapshot("agent-00000001") as AgentSnapshot;
    expect(completed.stats).toMatchObject({
      toolUses: 1,
      turnCount: 2,
      lifetimeUsage: { input: 3, output: 2, cacheWrite: 1, cost: 0.5 },
    });

    const continued = await runtime.execute({
      kind: "interact",
      id: "agent-00000001",
      message: "again",
    });
    expect(continued).toMatchObject({ ok: true, interaction: { accepted: true } });
    const continueRun = memory.continues.get("agent-00000001");
    continueRun?.emit({
      type: "failed",
      agentId: "agent-00000001",
      sessionId: "agent-00000001",
      error: "provider exploded",
    });
    continueRun?.resolve();
    expect(await runtime.waitUntilSettled("agent-00000001")).toMatchObject({
      status: "error",
      error: "provider exploded",
    });

    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "next",
      description: "next",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    await runtime.execute({ kind: "stop", id: "agent-00000002", initiator: "user" });
    expect(memory.aborts).toContain("agent-00000002");
    await runtime.execute({ kind: "close", id: "agent-00000002" });
    expect(memory.closes).toContain("agent-00000002");

    expect(events.slice(0, 5).map((event) => event.type)).toEqual([
      "setup-started",
      "setup-finished",
      "session-ready",
      "progress",
      "completed",
    ]);
  });
});
