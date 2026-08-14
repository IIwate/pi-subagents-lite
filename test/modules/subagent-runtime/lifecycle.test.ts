import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { acceptedRunPolicy } from "../../fixtures.ts";
import {
  AgentCommandResultSchema,
  AgentListSnapshotSchema,
  AgentSnapshotSchema,
  createSubagentRuntime,
  DEFAULT_RETENTION_MS,
  DEFAULT_TEARDOWN_TIMEOUT_MS,
  type AgentSnapshot,
  type ConcurrencyScheduler,
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

/** Timer port double whose registered callbacks the test fires by hand. */
function createTimers() {
  const intervals: Array<{ ms: number; run: () => void }> = [];
  const timeouts: Array<{ ms: number; run: () => void }> = [];
  return {
    intervals,
    timeouts,
    port: {
      interval(ms: number, run: () => void) {
        const entry = { ms, run };
        intervals.push(entry);
        return { clear() { intervals.splice(intervals.indexOf(entry), 1); } };
      },
      timeout(ms: number, run: () => void) {
        const entry = { ms, run };
        timeouts.push(entry);
        return { clear() { timeouts.splice(timeouts.indexOf(entry), 1); } };
      },
    },
  };
}

function createRuntime(
  driver: SessionDriver,
  overrides?: {
    clock?: { now(): number };
    limits?: { defaultModelLimit: number; modelLimits: Record<string, number>; providerLimits: Record<string, number> };
    worktree?: WorktreeInspector;
    concurrency?: ConcurrencyScheduler;
    timers?: ReturnType<typeof createTimers>["port"];
    cleanupIntervalMs?: number;
  },
) {
  return createSubagentRuntime({
    sessionDriver: driver,
    worktreeInspector: overrides?.worktree ?? acceptingWorktree,
    clock: overrides?.clock ?? { now: () => 1_000 },
    ids: createIds(),
    scheduler: overrides?.timers ?? {
      interval: () => ({ clear() {} }),
      timeout: () => ({ clear() {} }),
    },
    ...(overrides?.concurrency ? { concurrency: overrides.concurrency } : {}),
    ...(overrides?.cleanupIntervalMs != null ? { cleanupIntervalMs: overrides.cleanupIntervalMs } : {}),
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

async function failRun(
  memory: ReturnType<typeof createMemoryDriver>,
  id: string,
  error = "boom",
): Promise<void> {
  const run = memory.runs.get(id);
  if (!run) throw new Error(`missing run ${id}`);
  run.emit({
    type: "failed",
    agentId: id,
    sessionId: id,
    error,
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
    expect(Check(AgentCommandResultSchema, JSON.parse(JSON.stringify(first)))).toBe(true);
    expect(Check(AgentCommandResultSchema, second)).toBe(true);
    expect(first.ok && first.snapshot?.acceptedPolicy.model.id).toBe("4b_small");
    expect(first.ok && first.snapshot?.acceptedPolicy.model.id).not.toBe("outbound-stub");
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

  it("listSnapshots keeps acceptance order so a later queued row does not precede a running row", async () => {
    let now = 1_000;
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver, {
      clock: { now: () => { now += 1; return now; } },
      limits: {
        defaultModelLimit: 1,
        modelLimits: { "llamacpp/4b_small": 1 },
        providerLimits: {},
      },
    });

    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "running first",
      description: "running first",
      acceptedPolicy: acceptedRunPolicy("llamacpp/4b_small"),
    });
    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "queued later",
      description: "queued later",
      acceptedPolicy: acceptedRunPolicy("llamacpp/4b_small"),
    });

    const listed = runtime.listSnapshots();
    expect(listed.map((snapshot) => snapshot.status)).toEqual(["running", "queued"]);
    expect(listed[1]!.startedAt).toBeGreaterThan(listed[0]!.startedAt);
    expect(runtime.listSnapshots().map((snapshot) => snapshot.id)).toEqual([
      "agent-00000001",
      "agent-00000002",
    ]);
  });

  it("listSnapshots ranks attention above running, running above queued, queued above done, and keeps acceptance order inside a rank", async () => {
    let now = 1_000;
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver, {
      clock: { now: () => { now += 1; return now; } },
      limits: {
        defaultModelLimit: 1,
        modelLimits: { "llamacpp/4b_small": 1 },
        providerLimits: {},
      },
    });

    for (const description of [
      "first done",
      "error",
      "aborted",
      "turn limited",
      "second done",
      "running",
      "stopped",
      "queued",
    ]) {
      await runtime.execute({
        kind: "spawn",
        type: "general-purpose",
        prompt: description,
        description,
        acceptedPolicy: acceptedRunPolicy("llamacpp/4b_small"),
      });
    }

    await completeRun(memory, "agent-00000001");
    await failRun(memory, "agent-00000002");
    await completeRun(memory, "agent-00000003", { aborted: true });
    await completeRun(memory, "agent-00000004", { turnLimited: true });
    await completeRun(memory, "agent-00000005");
    await runtime.execute({ kind: "stop", id: "agent-00000007", initiator: "user" });
    expect(await runtime.execute({ kind: "pin", id: "agent-00000001" })).toMatchObject({
      ok: true,
      pinned: true,
    });

    const listed = runtime.listSnapshots();
    expect(
      listed.map((snapshot) => `${snapshot.id}:${snapshot.status}`),
      "error/aborted/turn_limited, then running, then queued, then archive in acceptance order; pin must not lift the first done row",
    ).toEqual([
      "agent-00000002:error",
      "agent-00000003:aborted",
      "agent-00000004:turn_limited",
      "agent-00000006:running",
      "agent-00000008:queued",
      "agent-00000001:completed",
      "agent-00000005:completed",
      "agent-00000007:stopped",
    ]);
    const queued = listed.find((snapshot) => snapshot.status === "queued");
    const firstDone = listed.find((snapshot) => snapshot.id === "agent-00000001");
    const secondDone = listed.find((snapshot) => snapshot.id === "agent-00000005");
    expect(secondDone?.startedAt).toBeGreaterThan(queued?.startedAt ?? 0);
    expect(secondDone?.startedAt).toBeGreaterThan(firstDone?.startedAt ?? 0);
    expect(firstDone?.pinnedAt).toEqual(expect.any(Number));

    const inspected = await runtime.execute({ kind: "inspect" });
    expect(inspected.ok && inspected.snapshots?.map((snapshot) => snapshot.id)).toEqual(
      listed.map((snapshot) => snapshot.id),
    );
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

  it("rejects an off-contract worktree inspect result before using .ok or .resolvedPath", async () => {
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver, {
      worktree: {
        async inspect() {
          return { ok: false } as never;
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
        message: "Worktree inspect result does not match its contract.",
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

  it("admits and releases through the injected scheduler instead of the built-in ceilings", async () => {
    const calls: string[] = [];
    let admit = true;
    const substitute: ConcurrencyScheduler = {
      reserve(key) {
        calls.push(`reserve:${key}`);
        return admit
          ? { accepted: true, concurrencyKey: key }
          : { accepted: false, reason: "concurrency", concurrencyKey: key };
      },
      release(key) { calls.push(`release:${key}`); },
      replaceLimits() { calls.push("replaceLimits"); },
    };
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver, {
      concurrency: substitute,
      limits: { defaultModelLimit: 99, modelLimits: {}, providerLimits: {} },
    });

    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "one",
      description: "one",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    admit = false;
    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "two",
      description: "two",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });

    // The generous `limits` would have admitted both runs; the substitute's
    // verdict is what the lifecycle acted on.
    expect(runtime.getSnapshot("agent-00000001")?.status).toBe("running");
    expect(runtime.getSnapshot("agent-00000002")?.status).toBe("queued");

    admit = true;
    await completeRun(memory, "agent-00000001");
    await Promise.resolve();
    expect(runtime.getSnapshot("agent-00000002")?.status).toBe("running");
    expect(calls).toEqual([
      "reserve:test/model",
      "reserve:test/model",
      "release:test/model",
      "reserve:test/model",
    ]);
  });

  it("REQ-RUNTIME-001 rejects a settled continuation when concurrency slots are full without enqueueing", async () => {
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver, {
      limits: { defaultModelLimit: 1, modelLimits: {}, providerLimits: {} },
    });

    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "settled",
      description: "settled",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    await completeRun(memory, "agent-00000001");
    expect(runtime.getSnapshot("agent-00000001")).toMatchObject({
      status: "completed",
      settled: true,
    });

    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "occupant",
      description: "occupant",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    expect(runtime.getSnapshot("agent-00000002")?.status).toBe("running");

    const queuedBefore = runtime.listSnapshots().filter((snapshot) => snapshot.status === "queued");
    const continued = await runtime.execute({
      kind: "interact",
      id: "agent-00000001",
      message: "follow up",
    });

    expect(continued).toMatchObject({
      ok: true,
      interaction: { accepted: false, reason: "concurrency", concurrencyKey: "test/model" },
    });
    expect(runtime.getSnapshot("agent-00000001")).toMatchObject({
      status: "completed",
      settled: true,
    });
    expect(runtime.listSnapshots().filter((snapshot) => snapshot.status === "queued")).toEqual(queuedBefore);
    expect(memory.continues.size).toBe(0);
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

  it("expires through the injected interval without an explicit expire command", async () => {
    const clock = createClock();
    const timers = createTimers();
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver, {
      clock,
      timers: timers.port,
      cleanupIntervalMs: 30_000,
    });
    const removed: string[] = [];
    runtime.setOnRemove((snapshot) => { removed.push(snapshot.id); });

    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "sweep",
      description: "sweep",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    await completeRun(memory, "agent-00000001");
    await runtime.execute({ kind: "mark-result", id: "agent-00000001", consumed: true });

    expect(timers.intervals.map((entry) => entry.ms)).toEqual([30_000]);
    clock.advance(DEFAULT_RETENTION_MS + 1);
    timers.intervals[0]?.run();
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.getSnapshot("agent-00000001")).toBeUndefined();
    expect(removed).toEqual(["agent-00000001"]);
    expect(memory.closes).toEqual(["agent-00000001"]);
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

  it("rejects an off-contract inspect result instead of continuing on live:\"yes\"", async () => {
    const memory = createMemoryDriver();
    memory.driver.inspect = () => ({
      found: true,
      live: "yes",
      streaming: false,
      messages: [],
    } as never);
    const runtime = createRuntime(memory.driver);

    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "task",
      description: "task",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    await completeRun(memory, "agent-00000001");

    const result = await runtime.execute({
      kind: "interact",
      id: "agent-00000001",
      message: "follow up",
    });
    expect(result).toMatchObject({
      ok: true,
      interaction: { accepted: false, reason: "unavailable" },
    });
    expect(memory.continues.size).toBe(0);
    expect(runtime.inspectSession("agent-00000001")).toEqual({
      found: false,
      live: false,
      streaming: false,
      messages: [],
    });
  });

  it("rejects an off-contract steer result instead of accepting on accepted:\"yes\"", async () => {
    const memory = createMemoryDriver();
    const steers: Array<{ sessionId: string; message: string }> = [];
    memory.driver.steer = async (request) => {
      steers.push({ sessionId: request.sessionId, message: request.message });
      return { accepted: "yes" } as never;
    };
    const runtime = createRuntime(memory.driver);

    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "task",
      description: "task",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });

    const result = await runtime.execute({
      kind: "interact",
      id: "agent-00000001",
      message: "new direction",
    });
    expect(result).toMatchObject({
      ok: true,
      interaction: { accepted: false, reason: "unavailable" },
    });
    expect(steers).toEqual([
      { sessionId: "agent-00000001", message: "new direction" },
    ]);
  });
});

describe("REQ-RUNTIME-002 close", () => {
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

describe("REQ-RUNTIME-006 shutdown", () => {
  it("is idempotent and rejects later spawn after disposal", async () => {
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver);
    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "task",
      description: "task",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    await runtime.dispose();
    await runtime.dispose();
    expect(runtime.listSnapshots()).toEqual([]);
    const late = await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "late",
      description: "late",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    expect(late).toEqual({
      ok: false,
      error: { code: "disposed", message: "Subagent runtime is disposed." },
    });
  });

  it("drops late driver events after disposal instead of resurrecting snapshots", async () => {
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver);
    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "task",
      description: "task",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    await runtime.dispose();
    await completeRun(memory, "agent-00000001");
    expect(runtime.getSnapshot("agent-00000001")).toBeUndefined();
    expect(runtime.listSnapshots()).toEqual([]);
  });

  it("keeps shutdown empty when abort rejects", async () => {
    const memory = createMemoryDriver();
    memory.driver.abort = async () => {
      throw new Error("abort refused");
    };
    const runtime = createRuntime(memory.driver);
    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "task",
      description: "task",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    const disposed = await runtime.execute({ kind: "dispose" });
    expect(Check(AgentCommandResultSchema, disposed)).toBe(true);
    expect(disposed).toEqual({ ok: true });
    expect(runtime.listSnapshots()).toEqual([]);
    const late = await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "late",
      description: "late",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    expect(late).toEqual({
      ok: false,
      error: { code: "disposed", message: "Subagent runtime is disposed." },
    });
  });

  it("does not apply an unrelated session event to the target snapshot", async () => {
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver);
    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "task",
      description: "task",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    const before = runtime.getSnapshot("agent-00000001");
    expect(before?.status).toBe("running");
    memory.runs.get("agent-00000001")?.emit({
      type: "completed",
      agentId: "agent-other",
      sessionId: "session-other",
      responseText: "foreign result",
      aborted: false,
      turnLimited: false,
    });
    memory.runs.get("agent-00000001")?.emit({
      type: "session-ready",
      agentId: "agent-ghost",
      sessionId: "session-ghost",
      modelId: "foreign/model",
      provider: "foreign",
    });
    const after = runtime.getSnapshot("agent-00000001");
    expect(after?.status).toBe("running");
    expect(after?.result).toBeUndefined();
    expect(after?.invocation?.modelName).toBe(before?.invocation?.modelName);
    expect(runtime.getSnapshot("agent-other")).toBeUndefined();
    expect(runtime.getSnapshot("agent-ghost")).toBeUndefined();
    expect(memory.aborts).toContain("session-ghost");
    expect(memory.closes).toContain("session-ghost");
  });

  it("bounds a hung setup wait to the teardown timeout", async () => {
    const memory = createMemoryDriver();
    memory.driver.start = (request, emit) => {
      emit({ type: "setup-started", agentId: request.agentId, sessionId: request.sessionId });
      return new Promise(() => {});
    };
    const timers = createTimers();
    const runtime = createRuntime(memory.driver, { timers: timers.port });
    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "task",
      description: "task",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    await Promise.resolve();
    const disposing = runtime.dispose();
    const teardown = timers.timeouts.find((entry) => entry.ms === DEFAULT_TEARDOWN_TIMEOUT_MS);
    expect(teardown).toBeDefined();
    teardown!.run();
    await disposing;
    expect(runtime.listSnapshots()).toEqual([]);
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
      contextPercent: 33,
    });
    await completeRun(memory, "agent-00000001", { responseText: "ok" });

    const completed = runtime.getSnapshot("agent-00000001") as AgentSnapshot;
    expect(completed.stats).toMatchObject({
      toolUses: 1,
      turnCount: 2,
      lifetimeUsage: { input: 3, output: 2, cacheWrite: 1, cost: 0.5 },
      contextPercent: 33,
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

  it("drops an off-contract driver event instead of publishing an invalid snapshot", async () => {
    const memory = createMemoryDriver();
    memory.driver.start = (request, emit) => {
      // A replacement driver that forwards a vendor thinking level verbatim.
      // The value is outside the canonical set, so applying it would leave the
      // published snapshot failing its own contract.
      emit({
        type: "session-ready",
        agentId: request.agentId,
        sessionId: request.sessionId,
        thinkingLevel: "ultra" as never,
      });
      return new Promise<void>(() => {});
    };

    const runtime = createRuntime(memory.driver);
    const spawned = await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "task",
      description: "task",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    expect(spawned).toMatchObject({ ok: true });

    const published = runtime.getSnapshot("agent-00000001") as AgentSnapshot;
    expect(Check(AgentSnapshotSchema, published)).toBe(true);
    expect(published.invocation?.thinkingLevel).toBeUndefined();
    expect(runtime.listSnapshots().every((snapshot) => Check(AgentListSnapshotSchema, snapshot))).toBe(true);
    expect(runtime.listSnapshots().every((snapshot) => !("acceptedPolicy" in snapshot))).toBe(true);
    // Dropping the event whole is the documented cost: readiness never lands,
    // so interaction queues instead of steering a session the runtime cannot
    // describe. Asserted here so the failure boundary stays visible.
    expect(published.liveSession).toBe(false);
    await runtime.execute({ kind: "interact", id: "agent-00000001", message: "nudge" });
    expect(memory.steers).toEqual([]);
  });

  it("listSnapshots omits acceptedPolicy and does not write through to the live record", async () => {
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver);
    const spawned = await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "task",
      description: "task",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });
    expect(Check(AgentCommandResultSchema, spawned)).toBe(true);
    expect(spawned.ok && spawned.snapshot?.acceptedPolicy.model.id).toBe("model");

    const listed = runtime.listSnapshots()[0];
    const fetched = runtime.getSnapshot("agent-00000001");
    expect(listed).toBeDefined();
    expect(fetched).toBeDefined();
    expect(Check(AgentListSnapshotSchema, listed)).toBe(true);
    expect(Check(AgentSnapshotSchema, fetched)).toBe(true);
    expect(listed).not.toHaveProperty("acceptedPolicy");
    expect(fetched?.acceptedPolicy.model.id).toBe("model");

    if (listed) {
      listed.status = "error";
      listed.stats.contextPercent = 1;
    }
    if (fetched) fetched.acceptedPolicy.model.id = "mutated";
    expect(runtime.getSnapshot("agent-00000001")?.status).toBe("running");
    expect(runtime.getSnapshot("agent-00000001")?.acceptedPolicy.model.id).toBe("model");
    expect(runtime.listSnapshots()[0]?.stats.contextPercent).toBeUndefined();
  });

  it("writes progress contextPercent onto stats so an unselected list row can read it", async () => {
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver);
    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "task",
      description: "task",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });

    memory.runs.get("agent-00000001")?.emit({
      type: "progress",
      agentId: "agent-00000001",
      sessionId: "agent-00000001",
      toolUse: true,
      contextPercent: 42,
    });
    expect(runtime.listSnapshots()[0]?.stats.contextPercent).toBe(42);
    expect(runtime.getSnapshot("agent-00000001")?.stats.contextPercent).toBe(42);

    memory.runs.get("agent-00000001")?.emit({
      type: "progress",
      agentId: "agent-00000001",
      sessionId: "agent-00000001",
      turnCount: 2,
      contextPercent: 57,
    });
    expect(runtime.listSnapshots()[0]?.stats.contextPercent).toBe(57);
    expect(Check(AgentListSnapshotSchema, runtime.listSnapshots()[0])).toBe(true);
  });
});

describe("mark-result command schema", () => {
  it("rejects invalid markResult fields without copying them onto the snapshot", async () => {
    const memory = createMemoryDriver();
    const runtime = createRuntime(memory.driver);
    await runtime.execute({
      kind: "spawn",
      type: "general-purpose",
      prompt: "task",
      description: "task",
      acceptedPolicy: acceptedRunPolicy("test/model"),
    });

    expect(runtime.markResult("agent-00000001", { persisted: "yes" as never })).toBeUndefined();
    expect(runtime.getSnapshot("agent-00000001")?.resultPersisted).toBeUndefined();

    const rejected = await runtime.execute({
      kind: "mark-result",
      id: "agent-00000001",
      persisted: "yes",
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "invalid-command", message: "Lifecycle command is invalid." },
    });
    expect(runtime.getSnapshot("agent-00000001")?.resultPersisted).toBeUndefined();

    expect(runtime.markResult("agent-00000001", { persisted: true })?.resultPersisted).toBe(true);
    const marked = await runtime.execute({ kind: "mark-result", id: "agent-00000001", consumed: true });
    expect(marked).toMatchObject({ ok: true, snapshot: { resultPersisted: true, resultConsumed: true } });
    expect(Check(AgentCommandResultSchema, JSON.parse(JSON.stringify(marked)))).toBe(true);
  });
});
