import { randomUUID } from "node:crypto";
import { QuotaUnavailable, type TaskEngine } from "../engine/task-engine.js";
import type { ExecutionSnapshot, TaskInput } from "../engine/contracts.js";
import type { NavigationAction, NavigationAgent, NavigationReply, NavigationSource, NavigationStatus, TranscriptSnapshot } from "./navigation.js";

const rank: Record<NavigationStatus, number> = { error: 0, aborted: 0, turn_limited: 0, running: 1, waiting: 1, cancelling: 1, queued: 2, completed: 3, stopped: 3 };

/** The UI binding projects engine values and dispatches commands without exposing a Lane. */
export class TaskNavigationSource implements NavigationSource {
  private readonly agents = new Map<string, NavigationAgent>();
  private readonly transcripts = new Map<string, ExecutionSnapshot>();
  private readonly watchers = new Map<string, () => void>();
  private readonly observers = new Map<string, Promise<() => void>>();
  private readonly listeners = new Set<() => void>();
  private readonly pins = new Map<string, number>();
  private readonly paused = new Map<string, number>();
  private readonly hidden = new Set<string>();
  private readonly dirty = new Set<string>();
  private refreshing?: Promise<void>;
  private disposed = false;
  private readonly unsubscribe: () => void;
  private readonly retention: ReturnType<typeof setInterval>;

  constructor(private readonly engine: TaskEngine) {
    this.unsubscribe = engine.subscribe(() => { void this.refresh(); });
    this.retention = setInterval(() => this.expire(), 60_000);
    this.retention.unref?.();
    void this.refresh();
  }

  listAgents(): readonly NavigationAgent[] {
    return [...this.agents.values()].filter(record => !this.hidden.has(record.id)).sort((a, b) =>
      rank[a.lifecycle.status] - rank[b.lifecycle.status]
      || Number(b.lifecycle.pinnedAt !== undefined) - Number(a.lifecycle.pinnedAt !== undefined)
      || (a.execution.settled && b.execution.settled
        ? (b.lifecycle.completedAt ?? 0) - (a.lifecycle.completedAt ?? 0) : a.lifecycle.startedAt - b.lifecycle.startedAt));
  }
  getRecord(taskId: string): NavigationAgent | undefined { return this.hidden.has(taskId) ? undefined : this.agents.get(taskId); }
  transcript(taskId: string): TranscriptSnapshot {
    const snapshot = this.transcripts.get(taskId);
    return { ready: Boolean(snapshot), messages: snapshot?.messages ?? [], streaming: snapshot?.streaming };
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  watchTranscript(taskId: string, listener: () => void): () => void {
    this.watchers.set(taskId, listener);
    return () => { this.watchers.delete(taskId); };
  }

  private expire(): void {
    let changed = false;
    for (const agent of this.agents.values()) {
      if (!agent.execution.settled || agent.lifecycle.completedAt === undefined || this.pins.has(agent.id) || this.hidden.has(agent.id)) continue;
      if (Date.now() < agent.lifecycle.completedAt + 600_000 + (this.paused.get(agent.id) ?? 0)) continue;
      this.hidden.add(agent.id);
      changed = true;
    }
    if (changed) for (const listener of this.listeners) listener();
  }

  refresh(taskId?: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    for (const id of taskId ? [taskId] : this.engine.list().map(task => task.taskId)) this.dirty.add(id);
    if (this.refreshing) return this.refreshing;
    this.refreshing = Promise.resolve().then(async () => {
        const ids = [...this.dirty]; this.dirty.clear();
        for (const id of ids) {
          if (this.disposed) return;
          const task = this.engine.get(id);
          try {
            if (!this.observers.has(task.taskId)) {
              const observer = this.engine.observe(task.taskId, () => { void this.refresh(task.taskId); });
              this.observers.set(task.taskId, observer);
              await observer;
              if (this.disposed) return;
            }
            const state = await this.engine.snapshot(task.taskId);
            if (this.disposed) return;
            const current = state.task;
            if (this.agents.get(task.taskId)?.operationId !== current.operationId) {
              this.paused.delete(task.taskId);
              this.hidden.delete(task.taskId);
            }
            const binding = this.engine.binding(current.taskId);
            const snapshot = state.execution;
            const observedOperation = snapshot.operation?.operationId ?? snapshot.lastResult?.operationId;
            if (observedOperation && observedOperation !== current.operationId) { this.dirty.add(task.taskId); continue; }
            const outcome = current.state.status === "settled" ? current.state.outcome : undefined;
            this.transcripts.set(task.taskId, snapshot);
            const now = Date.now();
            this.agents.set(task.taskId, Object.freeze({
              id: current.taskId, operationId: current.operationId,
              display: Object.freeze({ type: current.policy.agent, name: binding.display?.name ?? current.policy.agent,
                description: binding.display?.description ?? snapshot.messages.find(message => message.role === "user")?.text.split("\n")[0] ?? current.policy.agent }),
              lifecycle: Object.freeze({ status: outcome?.status ?? current.state.status as NavigationStatus,
                startedAt: snapshot.operation?.startedAt ?? snapshot.lastResult?.startedAt ?? now,
                completedAt: current.state.status === "settled" ? snapshot.lastResult?.completedAt : undefined,
                pinnedAt: this.pins.get(current.taskId), takenOver: current.control === "manual" }),
              execution: Object.freeze({ settled: current.state.status === "settled", providerName: current.policy.model.provider,
                modelName: current.policy.model.id, thinkingLevel: current.policy.thinkingLevel,
                retryState: snapshot.retry ? { attempt: snapshot.retry.attempt, maxAttempts: snapshot.retry.maxAttempts,
                  delayMs: Math.max(0, snapshot.retry.nextAttemptAt - now), startAt: now } : undefined }),
              stats: Object.freeze({ lifetimeUsage: { input: snapshot.stats.input, output: snapshot.stats.output, cost: snapshot.stats.cost },
                toolUses: snapshot.stats.toolUses, turnCount: snapshot.stats.turnCount, maxTurns: current.policy.limits.maxTurns,
                compactionCount: snapshot.stats.compactions, contextPercent: snapshot.stats.contextPercent }),
              queued: Object.freeze(snapshot.queued.map(item => Object.freeze({ entryId: item.entryId, kind: item.kind,
                input: Object.freeze({ text: item.text, images: item.images }) }))),
              result: outcome?.result, error: state.fault ? String(state.fault) : state.deliveryError ? String(state.deliveryError)
                : outcome?.status === "error" ? outcome.error : undefined,
              canDeliver: current.control === "manual" && snapshot.messages.some(message => (message.role === "user" || message.role === "assistant") && message.text.trim().length > 0),
            }));
            this.watchers.get(task.taskId)?.();
          } catch (error) {
            if (this.disposed) return;
            const previous = this.agents.get(task.taskId);
            if (previous) this.agents.set(task.taskId, Object.freeze({ ...previous, error: String(error) }));
            else this.agents.set(task.taskId, {
              id: task.taskId, operationId: task.operationId, display: { type: task.policy.agent, name: task.policy.agent, description: task.policy.agent },
              lifecycle: { status: task.state.status === "settled" ? task.state.outcome.status : task.state.status, startedAt: Date.now() },
              execution: { settled: task.state.status === "settled" },
              stats: { lifetimeUsage: { input: 0, output: 0, cost: 0 }, toolUses: 0, compactionCount: 0 },
              queued: [], canDeliver: false, error: String(error),
            });
          }
        }
        for (const listener of this.listeners) listener();
    }).finally(() => {
      this.refreshing = undefined;
      if (this.dirty.size && !this.disposed) {
        const id = this.dirty.values().next().value!;
        void this.refresh(id);
      }
    });
    return this.refreshing;
  }

  async dispatch(action: NavigationAction): Promise<NavigationReply> {
    if (this.disposed) return { accepted: false, reason: "unavailable" };
    if (action.type === "deliver") {
      const deliveryId = action.deliveryId ?? `selection:${randomUUID()}`;
      try {
        await this.engine.deliverSelection(action.selection.taskId, action.selection.messages,
          { deliveryId, operationId: action.selection.operationId, createdAt: action.selection.createdAt, status: action.selection.status });
        return { accepted: true, deliveryId };
      } catch (error) { return { accepted: false, reason: "save_failed", deliveryId, message: String(error) }; }
    }
    try {
      const task = this.engine.get(action.taskId);
      if (task.operationId !== action.operationId) return { accepted: false, reason: "unavailable", message: "The task has started another operation" };
      switch (action.type) {
        case "steer":
        case "followUp":
          await this.engine.queue(task.taskId, action.type, action.input);
          if (task.state.status === "waiting") this.engine.resume(task.taskId);
          return { accepted: true, message: this.engine.get(task.taskId).state.status === "settled" ? "Input queued. Continue the task to consume it." : undefined };
        case "continue": return { accepted: true, operationId: (await this.engine.continue(task.taskId, action.input)).operationId };
        case "takeover":
          await this.engine.takeOver(task.taskId); this.pins.set(task.taskId, Date.now()); return { accepted: true };
        case "abort":
        case "abortRetry": await this.engine.requestAbort(task.taskId, "user"); return { accepted: true };
        case "pin":
          if (this.pins.has(task.taskId)) {
            const completedAt = this.agents.get(task.taskId)?.lifecycle.completedAt;
            if (completedAt !== undefined) this.paused.set(task.taskId, (this.paused.get(task.taskId) ?? 0)
              + Date.now() - Math.max(completedAt, this.pins.get(task.taskId)!));
            this.pins.delete(task.taskId);
          } else this.pins.set(task.taskId, Date.now());
          return { accepted: true, pinned: this.pins.has(task.taskId) };
        case "remove":
          await this.engine.takeOver(task.taskId);
          if (this.engine.get(task.taskId).state.status !== "settled") await this.engine.requestAbort(task.taskId, "user");
          this.hidden.add(task.taskId); return { accepted: true };
        case "dequeue": {
          const snapshot = await this.engine.snapshot(task.taskId);
          const restored: TaskInput[] = [];
          for (const entryId of action.entryIds) {
            const item = snapshot.execution.queued.find(item => item.entryId === entryId);
            if (!item) continue;
            const result = await this.engine.cancelQueued(task.taskId, entryId);
            if (result === "cancelled") restored.push({ text: item.text, images: item.images });
          }
          return restored.length ? { accepted: true, restored } : { accepted: false, reason: "already_consumed" };
        }
      }
    } catch (error) {
      return error instanceof QuotaUnavailable ? { accepted: false, reason: "concurrency", modelKey: error.modelKey }
        : { accepted: false, reason: "unavailable", message: String(error) };
    } finally { await this.refresh(action.taskId); }
  }

  dispose(): void {
    clearInterval(this.retention);
    this.disposed = true; this.unsubscribe(); this.listeners.clear(); this.watchers.clear();
    for (const observer of this.observers.values()) void observer.then(stop => stop(), () => { /* Failed subscriptions own no resources. */ });
    this.observers.clear(); this.agents.clear(); this.transcripts.clear();
  }
}
