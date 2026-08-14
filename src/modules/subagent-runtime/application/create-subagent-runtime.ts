import { Check } from "typebox/value";
import {
  AgentCommandResultSchema,
  AgentCommandSchema,
  AgentListSnapshotSchema,
  AgentSnapshotSchema,
  DebugDiagnosticsSchema,
  MarkResultCommandSchema,
  DEFAULT_CLEANUP_INTERVAL_MS,
  DEFAULT_CONCURRENCY_LIMIT,
  DEFAULT_RETENTION_MS,
  DEFAULT_TEARDOWN_TIMEOUT_MS,
  type AgentCommand,
  type AgentCommandResult,
  type AgentListSnapshot,
  type AgentSnapshot,
  type DebugDiagnostics,
  type DebugFaultKind,
  type SpawnCommand,
} from "../contracts/lifecycle.js";
import { ConcurrencyLimitsSchema } from "../contracts/scheduling.js";
import { WorktreeInspectResultSchema } from "../contracts/worktree.js";
import {
  SessionEventSchema,
  SessionInspectResultSchema,
  SessionSteerResultSchema,
  type SessionEvent,
  type SessionInspectResult,
  type SessionSteerRequest,
} from "../contracts/session.js";
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
import { createConcurrencyScheduler, type ConcurrencyScheduler } from "./create-concurrency-scheduler.js";
import {
  describeAcceptedRunPolicyFailure,
  parseAcceptedRunPolicy,
} from "./validate-accepted-run-policy.js";
import { copyJson } from "./copy-json.js";

function asImages(images: unknown[] | undefined): SessionSteerRequest["images"] {
  return images as SessionSteerRequest["images"];
}

function absentSessionView(): SessionInspectResult {
  return { found: false, live: false, streaming: false, messages: [] };
}

/**
 * The session driver is a replaceable port. A typed-but-false inspect —
 * `live: "yes"`, a missing messages array — would let continue treat a
 * lie as a live idle session. The same absence inspectSession already
 * degrades to: no live session, the state every caller already renders
 * while a run is queued. Revisit if the port itself starts returning a
 * checked envelope.
 */
function sessionInspectView(view: unknown): SessionInspectResult {
  return Check(SessionInspectResultSchema, view) ? view : absentSessionView();
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
  /**
   * Admission control. Injectable so an alternative policy — a global pool, a
   * cost-aware ceiling — can be substituted without editing the lifecycle, and
   * so a contract test can observe the decisions the runtime acted on. Defaults
   * to the two-ceiling scheduler this module owns.
   */
  concurrency?: ConcurrencyScheduler;
  limits?: unknown;
  retentionMs?: number;
  cleanupIntervalMs?: number;
  teardownTimeoutMs?: number;
}

export interface SubagentRuntime {
  execute(command: unknown): Promise<AgentCommandResult>;
  getSnapshot(id: string): AgentSnapshot | undefined;
  listSnapshots(): AgentListSnapshot[];
  waitUntilSettled(id: string): Promise<AgentSnapshot | undefined>;
  inspectSession(id: string): ReturnType<SessionDriver["inspect"]>;
  stop(id: string, initiator?: AgentSnapshot["stoppedBy"]): boolean;
  markResult(id: string, fields: { persisted?: boolean; consumed?: boolean; deliveryId?: string }): AgentSnapshot | undefined;
  togglePinned(id: string): boolean | undefined;
  clear(id: string, initiator?: AgentSnapshot["stoppedBy"]): boolean;
  replaceLimits(limits: unknown): void;
  /**
   * Outbound subscription seams, not data on the boundary: the handler is a
   * local callback and every snapshot handed to it passes the same schema gate
   * as a returned one. Registered after construction because the composition
   * root builds delivery and the child screen from this runtime, so they cannot
   * be arguments to it without an indirection that only moves the cycle.
   */
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
  const scheduler = options.concurrency ?? createConcurrencyScheduler(options.limits ?? {
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

  /**
   * The one gate a full snapshot leaves through. A copy that fails the
   * contract is withheld rather than handed out: consumers project it into
   * rendering, persistence, and prompt text, so passing a malformed record
   * on turns one internal defect into a fault surfacing far from its cause.
   * Withholding degrades to an absent row or an unavailable interaction —
   * states every consumer already models. The accepted call is the real
   * object, not a stub swapped in after the Check. Revisit if a writer
   * starts slipping past the inbound session-event check.
   */
  function outbound(snapshot: AgentSnapshot | undefined): AgentSnapshot | undefined {
    if (!snapshot) return undefined;
    const copy = copyJson(snapshot);
    return Check(AgentSnapshotSchema, copy) ? copy : undefined;
  }

  /**
   * The list never read the accepted call. Cloning that catalog on every
   * tick was the hitch; stubbing the Check and hanging the live policy
   * back was how a caller could write through to the record. A thinner
   * row is the gate the refresh can pay for. Revisit if a list consumer
   * starts needing the accepted call.
   */
  function outboundList(snapshot: AgentSnapshot): AgentListSnapshot | undefined {
    const { acceptedPolicy: _acceptedPolicy, ...row } = snapshot;
    const copy = copyJson(row);
    return Check(AgentListSnapshotSchema, copy) ? copy : undefined;
  }

  /**
   * Snapshots already pass through outbound(). The envelope is the rest of
   * the answer — a missing error code, an interaction reason the schema
   * never named. Callers branch on ok and then read fields; a half-valid
   * success is how a dropped snapshot comes back as a present one.
   */
  function outboundResult(result: AgentCommandResult): AgentCommandResult {
    return Check(AgentCommandResultSchema, result)
      ? result
      : failure("invalid-command", "Lifecycle result does not match its contract.");
  }

  /**
   * Abort is teardown, not a state transition. A rejected abort must not
   * put a snapshot back or fail the command that already decided the
   * session was over. Revisit if the driver grows a way to report that
   * the process is still live after abort.
   */
  function abortSession(sessionId: string): void {
    void options.sessionDriver.abort({ sessionId }).catch(() => {});
  }

  function snapshotCopy(id: string): AgentSnapshot | undefined {
    return outbound(snapshots.get(id));
  }

  function listRows(): AgentListSnapshot[] {
    // Acceptance order is the list. Recency-by-startedAt looked harmless
    // until a later queued row, stamped at enqueue, climbed over running
    // work that had already begun. Pins must not move rows either.
    // Revisit only if product names an explicit status rank.
    return [...snapshots.values()].flatMap((snapshot) => {
      const emitted = outboundList(snapshot);
      return emitted ? [emitted] : [];
    });
  }

  function snapshotCopies(): AgentSnapshot[] {
    return [...snapshots.values()].flatMap((snapshot) => {
      const emitted = outbound(snapshot);
      return emitted ? [emitted] : [];
    });
  }

  function notifyComplete(snapshot: AgentSnapshot): void {
    // Delivery host marks persisted/consumed on the live snapshot first.
    // Waiters then observe that committed copy, not the pre-delivery one.
    const emitted = outbound(snapshot);
    if (emitted) {
      try { onComplete?.(emitted); } catch { /* host callbacks cannot poison settlement */ }
    }
    resolveWaiters(snapshot.id, snapshots.get(snapshot.id) ?? snapshot);
  }

  function notifyRemove(snapshot: AgentSnapshot): void {
    const emitted = outbound(snapshot);
    if (!emitted) return;
    try { onRemove?.(emitted); } catch { /* removal is already committed */ }
  }

  function resolveWaiters(id: string, snapshot: AgentSnapshot | undefined): void {
    const pending = waiters.get(id);
    if (!pending) return;
    waiters.delete(id);
    for (const resolve of pending) resolve(outbound(snapshot));
  }

  function releaseReservation(id: string): void {
    const key = reservedKeys.get(id);
    if (!key) return;
    reservedKeys.delete(id);
    scheduler.release(key);
  }

  function rejectLateSession(sessionId: string): void {
    pendingSteers.delete(sessionId);
    abortSession(sessionId);
    void options.sessionDriver.close({ sessionId });
  }

  function emitSessionEvent(event: SessionEvent): void {
    // The session driver is a replaceable adapter, so what it emits is an
    // inbound port boundary, not an internal call. An off-contract event is
    // dropped whole rather than applied field by field, because a partial
    // apply would leave the snapshot describing a session state that never
    // happened. Normalizing vendor values is the adapter's job: the Pi driver
    // maps its thinking level onto the canonical set before emitting.
    if (!Check(SessionEventSchema, event)) return;
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
    if (!acceptedPolicy) {
      return failure(
        "invalid-command",
        `Accepted run policy is invalid. ${describeAcceptedRunPolicyFailure(command.acceptedPolicy)}`,
      );
    }

    let worktreePath = command.worktreePath;
    if (worktreePath) {
      if (!command.parentCwd) {
        return failure("worktree-invalid", "Worktree targeting requires a parent working directory.");
      }
      const inspected = await options.worktreeInspector.inspect({
        worktreePath,
        parentCwd: command.parentCwd,
      });
      // The inspector is a replaceable port. A typed-but-false payload —
      // ok without a discriminant the schema named, an error that is not
      // a string — would let spawn treat garbage as a path or a reason.
      // Fail closed before reading either field. Revisit if the port
      // itself starts returning a checked envelope.
      if (!Check(WorktreeInspectResultSchema, inspected)) {
        return failure("worktree-invalid", "Worktree inspect result does not match its contract.");
      }
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
      return ok({ snapshot: outbound(snapshot) });
    }

    if (queued) {
      queue.push({ id, concurrencyKey, command });
      return ok({ snapshot: outbound(snapshot) });
    }

    void startAgent(command, snapshot);
    return ok({ snapshot: outbound(snapshot) });
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
      abortSession(snapshot.sessionId);
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
        return ok({ interaction: { accepted: true }, snapshot: outbound(snapshot) });
      }
      const steered = await options.sessionDriver.steer({
        sessionId: snapshot.sessionId,
        message,
        images: asImages(images),
      });
      // Same fail-closed gate as inspect: `accepted: "yes"` is not a
      // successful steer. The driver already saw the message; we refuse
      // to report acceptance from a payload the schema never named.
      if (!Check(SessionSteerResultSchema, steered) || !steered.accepted) {
        return ok({
          interaction: { accepted: false, reason: "unavailable" },
          snapshot: outbound(snapshot),
        });
      }
      return ok({
        interaction: { accepted: true },
        snapshot: outbound(snapshot),
      });
    }

    const view = snapshot.sessionId
      ? sessionInspectView(options.sessionDriver.inspect({ sessionId: snapshot.sessionId }))
      : absentSessionView();
    if (!snapshot.sessionId || !snapshot.settled || !view.live || view.streaming) {
      return ok({ interaction: { accepted: false, reason: "unavailable" }, snapshot: outbound(snapshot) });
    }

    if (!scheduler.reserve(snapshot.concurrencyKey).accepted) {
      return ok({
        interaction: { accepted: false, reason: "concurrency", concurrencyKey: snapshot.concurrencyKey },
        snapshot: outbound(snapshot),
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

    return ok({ interaction: { accepted: true }, snapshot: outbound(snapshot) });
  }

  function pin(id: string): AgentCommandResult {
    const snapshot = snapshots.get(id);
    if (!snapshot) return failure("not-found", `Unknown Subagent: ${id}`);
    if (snapshot.pinnedAt == null) {
      snapshot.pinnedAt = options.clock.now();
      return ok({ pinned: true, snapshot: outbound(snapshot) });
    }
    snapshot.cleanupExpiryPausedMs = unpinCleanupPausedMs(snapshot, options.clock.now());
    snapshot.pinnedAt = undefined;
    return ok({ pinned: false, snapshot: outbound(snapshot) });
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
        abortSession(snapshot.sessionId);
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

  function applyMarkResult(command: {
    id: string;
    persisted?: boolean;
    consumed?: boolean;
    deliveryId?: string;
  }): AgentSnapshot | undefined {
    const snapshot = snapshots.get(command.id);
    if (!snapshot) return undefined;
    if (command.persisted != null) snapshot.resultPersisted = command.persisted;
    if (command.consumed != null) snapshot.resultConsumed = command.consumed;
    if (command.deliveryId != null) snapshot.resultDeliveryId = command.deliveryId;
    return outbound(snapshot);
  }

  async function run(command: unknown): Promise<AgentCommandResult> {
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
          : ok({ snapshots: snapshotCopies() });
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
        const snapshot = applyMarkResult(next);
        return snapshot
          ? ok({ snapshot })
          : failure("not-found", `Unknown Subagent: ${next.id}`);
      }
      case "dispose":
        await disposeRuntime();
        return ok();
    }
  }

  return {
    async execute(command: unknown): Promise<AgentCommandResult> {
      return outboundResult(await run(command));
    },
    getSnapshot(id: string): AgentSnapshot | undefined {
      return snapshotCopy(id);
    },
    listSnapshots(): AgentListSnapshot[] {
      return listRows();
    },
    waitUntilSettled(id: string): Promise<AgentSnapshot | undefined> {
      const snapshot = snapshots.get(id);
      if (!snapshot) return Promise.resolve(undefined);
      if (snapshot.settled) return Promise.resolve(outbound(snapshot));
      return new Promise((resolve) => {
        const pending = waiters.get(id) ?? [];
        pending.push(resolve);
        waiters.set(id, pending);
      });
    },
    inspectSession(id: string) {
      const snapshot = snapshots.get(id);
      if (!snapshot?.sessionId) return absentSessionView();
      return sessionInspectView(options.sessionDriver.inspect({ sessionId: snapshot.sessionId }));
    },
    stop(id, initiator) {
      return stop(id, initiator);
    },
    markResult(id, fields) {
      // Same command schema as execute({ kind: "mark-result" }). The
      // convenience method used to copy fields that the command seam
      // would have refused, so a host typo could mark a result consumed
      // with a non-boolean and leave the snapshot unreadable outbound.
      const command = { kind: "mark-result" as const, id, ...fields };
      if (!Check(MarkResultCommandSchema, command)) return undefined;
      return applyMarkResult(command);
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
      const diagnostics = {
        ...(armedFault ? { armedFault: { kind: armedFault } } : {}),
        agents: listRows().map((snapshot) => ({
          id: snapshot.id,
          type: snapshot.type,
          status: snapshot.status,
          session: snapshot.liveSession ? "live" : "none",
          settled: snapshot.settled,
          resultConsumed: snapshot.resultConsumed === true,
          resultPersisted: snapshot.resultPersisted === true,
          ...(snapshot.debugFaultKind ? { debugFaultKind: snapshot.debugFaultKind } : {}),
          ...(snapshot.error ? { error: snapshot.error } : {}),
        })),
      };
      if (!Check(DebugDiagnosticsSchema, diagnostics)) {
        throw new TypeError("Debug diagnostics do not match their contract.");
      }
      return diagnostics;
    },
    dispose: disposeRuntime,
  };
}
