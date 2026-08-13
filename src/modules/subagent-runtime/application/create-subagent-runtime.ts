import { Check } from "typebox/value";
import {
  AgentCommandSchema,
  AgentSnapshotSchema,
  DEFAULT_CLEANUP_INTERVAL_MS,
  DEFAULT_CONCURRENCY_LIMIT,
  DEFAULT_RETENTION_MS,
  DEFAULT_TEARDOWN_TIMEOUT_MS,
  type AgentCommand,
  type AgentCommandResult,
  type AgentSnapshot,
  type DebugDiagnostics,
  type DebugFaultKind,
  type SpawnCommand,
} from "../contracts/lifecycle.js";
import { ConcurrencyLimitsSchema } from "../contracts/scheduling.js";
import type { SessionEvent, SessionSteerRequest } from "../contracts/session.js";
import type { SessionDriver } from "../ports/session-driver.js";
import type { WorktreeInspector } from "../ports/worktree-inspector.js";
import type { IdGenerator, RuntimeClock, RuntimeScheduler } from "../ports/runtime-services.js";
import {
  addUsage,
  concurrencyKeyFromPolicy,
  emptyUsage,
  isTerminalStatus,
} from "../core/lifecycle-status.js";
import { shouldExpire, unpinCleanupPausedMs } from "../core/retention.js";
import { createConcurrencyScheduler } from "./create-concurrency-scheduler.js";
import { parseAcceptedRunPolicy } from "./validate-accepted-run-policy.js";
import { copyJson } from "./copy-json.js";

function asImages(images: unknown[] | undefined): SessionSteerRequest["images"] {
  return images as SessionSteerRequest["images"];
}

function canOverwriteStatus(status: AgentSnapshot["status"]): boolean {
  return status !== "stopped";
}

export interface CreateSubagentRuntimeOptions {
  sessionDriver: SessionDriver;
  worktreeInspector: WorktreeInspector;
  clock: RuntimeClock;
  ids: IdGenerator;
  scheduler: RuntimeScheduler;
  limits?: unknown;
  retentionMs?: number;
  cleanupIntervalMs?: number;
  teardownTimeoutMs?: number;
}

export interface SubagentRuntime {
  execute(command: unknown): Promise<AgentCommandResult>;
  getSnapshot(id: string): AgentSnapshot | undefined;
  listSnapshots(): AgentSnapshot[];
  waitUntilSettled(id: string): Promise<AgentSnapshot | undefined>;
  inspectSession(id: string): ReturnType<SessionDriver["inspect"]>;
  stop(id: string, initiator?: AgentSnapshot["stoppedBy"]): boolean;
  markResult(id: string, fields: { persisted?: boolean; consumed?: boolean; deliveryId?: string }): AgentSnapshot | undefined;
  togglePinned(id: string): boolean | undefined;
  clear(id: string, initiator?: AgentSnapshot["stoppedBy"]): boolean;
  replaceLimits(limits: unknown): void;
  setOnComplete(handler: (snapshot: AgentSnapshot) => void): void;
  setOnRemove(handler: (snapshot: AgentSnapshot) => void): void;
  debugDiagnostics(): DebugDiagnostics;
  dispose(): Promise<void>;
}

interface QueueEntry {
  id: string;
  concurrencyKey: string;
  command: SpawnCommand;
}

interface PendingSteer {
  message: string;
  images?: unknown[];
}

function failure(
  code: Extract<AgentCommandResult, { ok: false }>["error"]["code"],
  message: string,
): AgentCommandResult {
  return { ok: false, error: { code, message } };
}

function ok(fields: Omit<Extract<AgentCommandResult, { ok: true }>, "ok"> = {}): AgentCommandResult {
  return { ok: true, ...fields };
}

export function createSubagentRuntime(options: CreateSubagentRuntimeOptions): SubagentRuntime {
  const snapshots = new Map<string, AgentSnapshot>();
  const queue: QueueEntry[] = [];
  const pendingSteers = new Map<string, PendingSteer[]>();
  const waiters = new Map<string, Array<(snapshot: AgentSnapshot | undefined) => void>>();
  const reservedKeys = new Map<string, string>();
  const pendingSetups = new Set<Promise<void>>();
  const closing = new Set<Promise<void>>();
  const scheduler = createConcurrencyScheduler(options.limits ?? {
    defaultModelLimit: DEFAULT_CONCURRENCY_LIMIT,
    modelLimits: {},
    providerLimits: {},
  });
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const teardownTimeoutMs = options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;
  let armedFault: DebugFaultKind | undefined;
  let disposing = false;
  let onComplete: ((snapshot: AgentSnapshot) => void) | undefined;
  let onRemove: ((snapshot: AgentSnapshot) => void) | undefined;

  const cleanupHandle = options.scheduler.interval(
    options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS,
    () => { void expireRecords(); },
  );

  function snapshotCopy(id: string): AgentSnapshot | undefined {
    const snapshot = snapshots.get(id);
    return snapshot && Check(AgentSnapshotSchema, snapshot) ? copyJson(snapshot) : snapshot ? copyJson(snapshot) : undefined;
  }

  function listCopies(): AgentSnapshot[] {
    return [...snapshots.values()]
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((snapshot) => copyJson(snapshot));
  }

  function notifyComplete(snapshot: AgentSnapshot): void {
    // Delivery host marks persisted/consumed on the live snapshot first.
    // Waiters then observe that committed copy, not the pre-delivery one.
    try { onComplete?.(copyJson(snapshot)); } catch { /* host callbacks cannot poison settlement */ }
    resolveWaiters(snapshot.id, snapshots.get(snapshot.id) ?? snapshot);
  }

  function notifyRemove(snapshot: AgentSnapshot): void {
    try { onRemove?.(copyJson(snapshot)); } catch { /* removal is already committed */ }
  }

  function resolveWaiters(id: string, snapshot: AgentSnapshot | undefined): void {
    const pending = waiters.get(id);
    if (!pending) return;
    waiters.delete(id);
    for (const resolve of pending) resolve(snapshot ? copyJson(snapshot) : undefined);
  }

  function releaseReservation(id: string): void {
    const key = reservedKeys.get(id);
    if (!key) return;
    reservedKeys.delete(id);
    scheduler.release(key);
  }

  function rejectLateSession(sessionId: string): void {
    pendingSteers.delete(sessionId);
    void options.sessionDriver.abort({ sessionId });
    void options.sessionDriver.close({ sessionId });
  }

  function emitSessionEvent(event: SessionEvent): void {
    const snapshot = snapshots.get(event.agentId);
    if (!snapshot) {
      if (event.type === "session-ready") rejectLateSession(event.sessionId);
      return;
    }
    if (event.type === "setup-started" || event.type === "setup-finished") return;
    if (event.type === "session-ready") {
      snapshot.sessionId = event.sessionId;
      if (snapshot.status === "stopped" || snapshot.status === "error") {
        snapshot.liveSession = false;
        pendingSteers.delete(snapshot.id);
        rejectLateSession(event.sessionId);
        return;
      }
      snapshot.liveSession = true;
      const invocation = { ...(snapshot.invocation ?? {}) };
      if (event.modelId) invocation.modelName = event.modelId;
      if (event.provider) invocation.providerName = event.provider;
      if (event.thinkingLevel) invocation.thinkingLevel = event.thinkingLevel;
      snapshot.invocation = invocation;
      const queued = pendingSteers.get(snapshot.id);
      pendingSteers.delete(snapshot.id);
      if (queued) {
        for (const steer of queued) {
          void options.sessionDriver.steer({
            sessionId: event.sessionId,
            message: steer.message,
            images: asImages(steer.images),
          });
        }
      }
      return;
    }
    if (event.type === "progress") {
      if (event.toolUse) snapshot.stats.toolUses += 1;
      if (event.usage) addUsage(snapshot.stats.lifetimeUsage, event.usage);
      if (event.compaction) snapshot.stats.compactionCount += 1;
      if (event.turnCount != null) snapshot.stats.turnCount = event.turnCount;
      if (event.contextPercent !== undefined) snapshot.stats.contextPercent = event.contextPercent;
      return;
    }
    if (event.type === "completed") {
      if (canOverwriteStatus(snapshot.status)) {
        snapshot.status = event.aborted ? "aborted" : event.turnLimited ? "turn_limited" : "completed";
      }
      snapshot.result = event.responseText;
      if (event.contextPercent !== undefined) snapshot.stats.contextPercent = event.contextPercent;
      snapshot.completedAt ??= options.clock.now();
      return;
    }
    if (canOverwriteStatus(snapshot.status)) snapshot.status = "error";
    snapshot.result = undefined;
    snapshot.error = event.error;
    snapshot.completedAt ??= options.clock.now();
  }

  async function startAgent(command: SpawnCommand, snapshot: AgentSnapshot): Promise<void> {
    const debugFault = armedFault;
    armedFault = undefined;
    snapshot.status = "running";
    snapshot.startedAt = options.clock.now();
    snapshot.settled = false;
    snapshot.sessionId = snapshot.id;
    if (debugFault) snapshot.debugFaultKind = debugFault;

    let setupStarted = false;
    let resolveSetup!: () => void;
    const setupFinished = new Promise<void>((resolve) => { resolveSetup = resolve; });
    const markSetupStarted = () => {
      setupStarted = true;
      pendingSetups.add(setupFinished);
    };
    const markSetupFinished = () => {
      if (!setupStarted) return;
      pendingSetups.delete(setupFinished);
      resolveSetup();
    };

    const emit: typeof emitSessionEvent = (event) => {
      if (event.type === "setup-started") markSetupStarted();
      if (event.type === "setup-finished") markSetupFinished();
      emitSessionEvent(event);
    };

    try {
      await options.sessionDriver.start({
        agentId: snapshot.id,
        sessionId: snapshot.id,
        agentType: command.type,
        prompt: command.prompt,
        acceptedPolicy: snapshot.acceptedPolicy,
        worktreePath: snapshot.worktreePath,
        debugFault,
      }, emit);
    } catch (error) {
      markSetupFinished();
      if (disposing || !snapshots.has(snapshot.id)) return;
      if (canOverwriteStatus(snapshot.status)) snapshot.status = "error";
      snapshot.error = error instanceof Error ? error.message : String(error);
      snapshot.result = undefined;
      snapshot.completedAt ??= options.clock.now();
    } finally {
      markSetupFinished();
      if (!disposing && snapshots.has(snapshot.id)) {
        snapshot.settled = true;
        if (!snapshot.completedAt && isTerminalStatus(snapshot.status)) {
          snapshot.completedAt = options.clock.now();
        }
        if (snapshot.status === "running") {
          snapshot.status = "completed";
          snapshot.completedAt ??= options.clock.now();
        }
        releaseReservation(snapshot.id);
        notifyComplete(snapshot);
        drainQueue();
      } else {
        releaseReservation(snapshot.id);
        resolveWaiters(snapshot.id, snapshots.get(snapshot.id));
      }
    }
  }

  function drainQueue(): void {
    const started = new Set<string>();
    for (const entry of queue) {
      const snapshot = snapshots.get(entry.id);
      if (!snapshot || snapshot.status !== "queued") continue;
      if (!scheduler.reserve(entry.concurrencyKey).accepted) continue;
      reservedKeys.set(entry.id, entry.concurrencyKey);
      started.add(entry.id);
      void startAgent(entry.command, snapshot).catch((error) => {
        snapshot.status = "error";
        snapshot.error = error instanceof Error ? error.message : String(error);
        snapshot.settled = true;
        snapshot.completedAt = options.clock.now();
        releaseReservation(entry.id);
        notifyComplete(snapshot);
      });
    }
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (started.has(queue[index].id)) queue.splice(index, 1);
    }
  }

  async function spawn(command: SpawnCommand): Promise<AgentCommandResult> {
    if (disposing) return failure("disposed", "Subagent runtime is disposed.");
    const acceptedPolicy = parseAcceptedRunPolicy(command.acceptedPolicy);
    if (!acceptedPolicy) return failure("invalid-command", "Accepted run policy is invalid.");

    let worktreePath = command.worktreePath;
    if (worktreePath) {
      if (!command.parentCwd) {
        return failure("worktree-invalid", "Worktree targeting requires a parent working directory.");
      }
      const inspected = await options.worktreeInspector.inspect({
        worktreePath,
        parentCwd: command.parentCwd,
      });
      if (!inspected.ok) return failure("worktree-invalid", inspected.error);
      worktreePath = inspected.resolvedPath;
    }

    const id = options.ids.nextId();
    const concurrencyKey = concurrencyKeyFromPolicy(
      acceptedPolicy.model.provider,
      acceptedPolicy.model.id,
    );
    const reservedNow = scheduler.reserve(concurrencyKey).accepted;
    if (reservedNow) reservedKeys.set(id, concurrencyKey);
    const queued = !reservedNow;
    const snapshot: AgentSnapshot = {
      id,
      type: command.type,
      description: command.description,
      status: queued ? "queued" : "running",
      startedAt: options.clock.now(),
      invocation: command.invocation,
      acceptedPolicy,
      concurrencyKey,
      settled: false,
      liveSession: false,
      resultSessionId: command.resultSessionId,
      resultOriginEntryId: command.resultOriginEntryId,
      graceTurns: acceptedPolicy.graceTurns,
      worktreePath,
      stats: {
        lifetimeUsage: emptyUsage(),
        toolUses: 0,
        turnCount: 1,
        maxTurns: acceptedPolicy.turnLimit ?? undefined,
        compactionCount: 0,
      },
    };
    snapshots.set(id, snapshot);

    if (command.parentAborted) {
      snapshot.status = "stopped";
      snapshot.stoppedBy = "user";
      snapshot.completedAt = options.clock.now();
      snapshot.settled = true;
      if (queued) {
        // never queued
      } else {
        releaseReservation(id);
      }
      notifyComplete(snapshot);
      return ok({ snapshot: copyJson(snapshot) });
    }

    if (queued) {
      queue.push({ id, concurrencyKey, command });
      return ok({ snapshot: copyJson(snapshot) });
    }

    void startAgent(command, snapshot);
    return ok({ snapshot: copyJson(snapshot) });
  }

  function stop(id: string, initiator?: AgentSnapshot["stoppedBy"], notify = true): boolean {
    const snapshot = snapshots.get(id);
    if (!snapshot) return false;
    const wasQueued = snapshot.status === "queued";
    if (wasQueued) {
      const index = queue.findIndex((entry) => entry.id === id);
      if (index >= 0) queue.splice(index, 1);
    } else if (snapshot.status !== "running") {
      return false;
    }
    snapshot.status = "stopped";
    snapshot.stoppedBy = initiator;
    snapshot.completedAt = options.clock.now();
    if (wasQueued) {
      snapshot.settled = true;
      if (notify) notifyComplete(snapshot);
    } else if (snapshot.liveSession && snapshot.sessionId) {
      void options.sessionDriver.abort({ sessionId: snapshot.sessionId });
    }
    return true;
  }

  async function interact(id: string, message: string, images?: unknown[]): Promise<AgentCommandResult> {
    const snapshot = snapshots.get(id);
    if (!snapshot) return ok({ interaction: { accepted: false, reason: "unavailable" } });
    if (snapshot.status === "queued") return ok({ interaction: { accepted: false, reason: "queued" } });

    if (snapshot.status === "running") {
      if (!snapshot.liveSession || !snapshot.sessionId) {
        const pending = pendingSteers.get(id) ?? [];
        pending.push({ message, images });
        pendingSteers.set(id, pending);
        return ok({ interaction: { accepted: true }, snapshot: copyJson(snapshot) });
      }
      const steered = await options.sessionDriver.steer({
        sessionId: snapshot.sessionId,
        message,
        images: asImages(images),
      });
      return ok({
        interaction: steered.accepted ? { accepted: true } : { accepted: false, reason: "unavailable" },
        snapshot: copyJson(snapshot),
      });
    }

    const view = snapshot.sessionId
      ? options.sessionDriver.inspect({ sessionId: snapshot.sessionId })
      : { found: false, live: false, streaming: false, messages: [] };
    if (!snapshot.sessionId || !snapshot.settled || !view.live || view.streaming) {
      return ok({ interaction: { accepted: false, reason: "unavailable" }, snapshot: copyJson(snapshot) });
    }

    if (!scheduler.reserve(snapshot.concurrencyKey).accepted) {
      return ok({
        interaction: { accepted: false, reason: "concurrency", concurrencyKey: snapshot.concurrencyKey },
        snapshot: copyJson(snapshot),
      });
    }
    reservedKeys.set(id, snapshot.concurrencyKey);

    const previousTurns = snapshot.stats.turnCount ?? 0;
    snapshot.settled = false;
    snapshot.status = "running";
    snapshot.startedAt = options.clock.now();
    snapshot.completedAt = undefined;
    snapshot.cleanupExpiryPausedMs = undefined;
    snapshot.resultPersisted = undefined;
    snapshot.resultConsumed = undefined;
    snapshot.resultDeliveryId = undefined;
    snapshot.result = undefined;
    snapshot.error = undefined;

    void (async () => {
      try {
        await options.sessionDriver.continueRun({
          agentId: id,
          sessionId: snapshot.sessionId!,
          prompt: message,
          images: asImages(images),
          maxTurns: snapshot.stats.maxTurns,
          graceTurns: snapshot.graceTurns,
        }, (event) => {
          if (event.type === "progress" && event.turnCount != null) {
            emitSessionEvent({ ...event, turnCount: previousTurns + event.turnCount });
            return;
          }
          emitSessionEvent(event);
        });
      } catch (error) {
        if (canOverwriteStatus(snapshot.status)) snapshot.status = "error";
        snapshot.error = error instanceof Error ? error.message : String(error);
        snapshot.result = undefined;
        snapshot.completedAt ??= options.clock.now();
      } finally {
        snapshot.settled = true;
        if (snapshot.status === "running") {
          snapshot.status = "completed";
          snapshot.completedAt ??= options.clock.now();
        }
        if (!snapshot.resultSessionId) snapshot.resultConsumed = true;
        releaseReservation(id);
        notifyComplete(snapshot);
        drainQueue();
      }
    })();

    return ok({ interaction: { accepted: true }, snapshot: copyJson(snapshot) });
  }

  function pin(id: string): AgentCommandResult {
    const snapshot = snapshots.get(id);
    if (!snapshot) return failure("not-found", `Unknown Subagent: ${id}`);
    if (snapshot.pinnedAt == null) {
      snapshot.pinnedAt = options.clock.now();
      return ok({ pinned: true, snapshot: copyJson(snapshot) });
    }
    snapshot.cleanupExpiryPausedMs = unpinCleanupPausedMs(snapshot, options.clock.now());
    snapshot.pinnedAt = undefined;
    return ok({ pinned: false, snapshot: copyJson(snapshot) });
  }

  async function closeSession(sessionId: string): Promise<void> {
    const done = options.sessionDriver.close({ sessionId }).catch(() => undefined);
    closing.add(done);
    await done;
    closing.delete(done);
  }

  async function removeRecord(id: string): Promise<void> {
    const snapshot = snapshots.get(id);
    if (!snapshot) return;
    const sessionId = snapshot.sessionId;
    snapshot.liveSession = false;
    snapshots.delete(id);
    pendingSteers.delete(id);
    releaseReservation(id);
    resolveWaiters(id, undefined);
    if (sessionId) void closeSession(sessionId);
    notifyRemove(snapshot);
    drainQueue();
  }

  async function expireRecords(): Promise<string[]> {
    const now = options.clock.now();
    const expired: string[] = [];
    for (const snapshot of [...snapshots.values()]) {
      if (!shouldExpire(snapshot, now, retentionMs)) continue;
      expired.push(snapshot.id);
      await removeRecord(snapshot.id);
    }
    return expired;
  }

  async function close(id: string, initiator?: AgentSnapshot["stoppedBy"]): Promise<AgentCommandResult> {
    const snapshot = snapshots.get(id);
    if (!snapshot) return failure("not-found", `Unknown Subagent: ${id}`);
    if (!isTerminalStatus(snapshot.status)) stop(id, initiator ?? "user", false);
    await removeRecord(id);
    return ok({ closed: true });
  }

  async function disposeRuntime(): Promise<void> {
    if (disposing) return;
    disposing = true;
    cleanupHandle.clear();
    for (const snapshot of snapshots.values()) {
      if (snapshot.status === "running" && snapshot.sessionId) {
        void options.sessionDriver.abort({ sessionId: snapshot.sessionId });
      }
    }
    for (const snapshot of snapshots.values()) {
      if (snapshot.status !== "queued") continue;
      snapshot.status = "error";
      snapshot.error = "Agent manager disposed before the queued agent could start.";
      snapshot.completedAt = options.clock.now();
      snapshot.settled = true;
      resolveWaiters(snapshot.id, snapshot);
    }
    queue.length = 0;
    for (const snapshot of snapshots.values()) {
      const sessionId = snapshot.sessionId;
      snapshot.liveSession = false;
      if (sessionId) void closeSession(sessionId);
    }
    snapshots.clear();
    pendingSteers.clear();
    if (pendingSetups.size > 0) {
      let timer: ReturnType<RuntimeScheduler["timeout"]> | undefined;
      await Promise.race([
        Promise.all([...pendingSetups]),
        new Promise<void>((resolve) => {
          timer = options.scheduler.timeout(teardownTimeoutMs, resolve);
        }),
      ]);
      timer?.clear();
    }
    while (closing.size > 0) {
      await Promise.all([...closing]);
    }
  }

  return {
    async execute(command: unknown): Promise<AgentCommandResult> {
      if (!Check(AgentCommandSchema, command)) {
        return failure("invalid-command", "Lifecycle command is invalid.");
      }
      const next = command as AgentCommand;
      switch (next.kind) {
        case "spawn":
          return spawn(next);
        case "stop":
          return ok({ stopped: stop(next.id, next.initiator), snapshot: snapshotCopy(next.id) });
        case "interact":
          return interact(next.id, next.message, next.images);
        case "inspect":
          return next.id
            ? snapshots.has(next.id)
              ? ok({ snapshot: snapshotCopy(next.id) })
              : failure("not-found", `Unknown Subagent: ${next.id}`)
            : ok({ snapshots: listCopies() });
        case "pin":
          return pin(next.id);
        case "expire":
          return ok({ expiredIds: await expireRecords() });
        case "close":
          return close(next.id, next.initiator);
        case "replace-limits":
          if (!Check(ConcurrencyLimitsSchema, next.limits)) {
            return failure("invalid-command", "Concurrency limits are invalid.");
          }
          scheduler.replaceLimits(next.limits);
          drainQueue();
          return ok();
        case "arm-debug-fault":
          armedFault = next.fault;
          return ok();
        case "clear-debug-fault":
          armedFault = undefined;
          return ok();
        case "mark-result": {
          const snapshot = snapshots.get(next.id);
          if (!snapshot) return failure("not-found", `Unknown Subagent: ${next.id}`);
          if (next.persisted != null) snapshot.resultPersisted = next.persisted;
          if (next.consumed != null) snapshot.resultConsumed = next.consumed;
          if (next.deliveryId != null) snapshot.resultDeliveryId = next.deliveryId;
          return ok({ snapshot: copyJson(snapshot) });
        }
        case "dispose":
          await disposeRuntime();
          return ok();
      }
    },
    getSnapshot(id: string): AgentSnapshot | undefined {
      return snapshotCopy(id);
    },
    listSnapshots(): AgentSnapshot[] {
      return listCopies();
    },
    waitUntilSettled(id: string): Promise<AgentSnapshot | undefined> {
      const snapshot = snapshots.get(id);
      if (!snapshot) return Promise.resolve(undefined);
      if (snapshot.settled) return Promise.resolve(copyJson(snapshot));
      return new Promise((resolve) => {
        const pending = waiters.get(id) ?? [];
        pending.push(resolve);
        waiters.set(id, pending);
      });
    },
    inspectSession(id: string) {
      const snapshot = snapshots.get(id);
      if (!snapshot?.sessionId) {
        return { found: false, live: false, streaming: false, messages: [] };
      }
      return options.sessionDriver.inspect({ sessionId: snapshot.sessionId });
    },
    stop(id, initiator) {
      return stop(id, initiator);
    },
    markResult(id, fields) {
      const snapshot = snapshots.get(id);
      if (!snapshot) return undefined;
      if (fields.persisted != null) snapshot.resultPersisted = fields.persisted;
      if (fields.consumed != null) snapshot.resultConsumed = fields.consumed;
      if (fields.deliveryId != null) snapshot.resultDeliveryId = fields.deliveryId;
      return copyJson(snapshot);
    },
    togglePinned(id) {
      const result = pin(id);
      return result.ok ? result.pinned : undefined;
    },
    clear(id, initiator = "user") {
      const snapshot = snapshots.get(id);
      if (!snapshot) return false;
      void close(id, initiator);
      return true;
    },
    replaceLimits(limits) {
      if (!Check(ConcurrencyLimitsSchema, limits)) {
        throw new TypeError("Concurrency limits are invalid.");
      }
      scheduler.replaceLimits(limits);
      drainQueue();
    },
    setOnComplete(handler) {
      onComplete = handler;
    },
    setOnRemove(handler) {
      onRemove = handler;
    },
    debugDiagnostics(): DebugDiagnostics {
      return {
        armedFault: armedFault ? { kind: armedFault } : undefined,
        agents: listCopies().map((snapshot) => ({
          id: snapshot.id,
          type: snapshot.type,
          status: snapshot.status,
          session: snapshot.liveSession ? "live" : "none",
          settled: snapshot.settled,
          resultConsumed: snapshot.resultConsumed === true,
          resultPersisted: snapshot.resultPersisted === true,
          debugFaultKind: snapshot.debugFaultKind,
          error: snapshot.error,
        })),
      };
    },
    dispose: disposeRuntime,
  };
}
