import { randomUUID } from "node:crypto";
import { Quota, type QuotaLimits } from "../domain/quota.js";
import { createTask, reduceTask, type Task } from "../domain/task.js";
import type { DeliveryChannel, ExecutionDriver, ExecutionMessage, ExecutionResult, TaskDelivery, TaskInput } from "./contracts.js";

interface TrackedTask {
  driver: ExecutionDriver;
  task: Task;
  scheduled: boolean;
  driving?: Promise<void>;
  continuing?: boolean;
  fault?: unknown;
  deliveryError?: unknown;
}

/** Owns admission and control; execution and durable completion remain driver facts. */
export class TaskEngine {
  private readonly records = new Map<string, TrackedTask>();
  private readonly accepting = new Map<string, ExecutionDriver>();
  private readonly listeners = new Set<() => void>();
  private readonly quota: Quota;
  private flushing?: Promise<void>;
  private flushAgain = false;
  private closing?: Promise<void>;

  constructor(limits: QuotaLimits, private readonly delivery: DeliveryChannel) {
    this.quota = new Quota(limits);
  }

  async accept(driver: ExecutionDriver, input: TaskInput): Promise<Task> {
    this.claim(driver);
    try {
      const operationId = await driver.accept(input);
      this.assertOpen();
      const record = this.record(driver, operationId);
      record.scheduled = true;
      this.records.set(record.task.taskId, record);
      this.drain();
      return record.task;
    } catch (error) {
      await driver.close();
      throw error;
    } finally {
      this.accepting.delete(driver.store.binding.taskId);
    }
  }

  /** Attachment discovers native state; only resume() grants execution responsibility. */
  async restore(driver: ExecutionDriver): Promise<Task> {
    this.claim(driver);
    try {
      const snapshot = await driver.snapshot();
      this.assertOpen();
      const operationId = snapshot.operation?.operationId ?? snapshot.lastResult?.operationId;
      if (!operationId) throw new Error("The task has no accepted operation");
      const record = this.record(driver, operationId);
      this.records.set(record.task.taskId, record);
      if (snapshot.operation) {
        record.task = reduceTask(record.task, { type: snapshot.operation.cancelling ? "cancel_requested" : "waiting", operationId });
      } else if (snapshot.lastResult) {
        await this.complete(record, snapshot.lastResult);
      }
      this.notify();
      return record.task;
    } catch (error) {
      await driver.close();
      this.records.delete(driver.store.binding.taskId);
      throw error;
    } finally {
      this.accepting.delete(driver.store.binding.taskId);
    }
  }

  get(taskId: string): Task { return this.require(taskId).task; }
  list(): readonly Task[] { return [...this.records.values()].map(record => record.task); }

  async snapshot(taskId: string) {
    const record = this.require(taskId);
    return { task: record.task, execution: await record.driver.snapshot(), fault: record.fault, deliveryError: record.deliveryError };
  }

  subscribe(listener: () => void): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  setLimits(limits: QuotaLimits): void {
    this.assertOpen();
    this.quota.setLimits(limits);
    this.drain();
  }

  resume(taskId: string): void {
    this.assertOpen();
    const record = this.require(taskId);
    if (record.fault) throw record.fault;
    if (record.task.state.status === "settled") throw new Error("A settled task requires an explicit continuation");
    record.scheduled = !record.driving;
    this.drain();
  }

  async continue(taskId: string, input: TaskInput): Promise<Task> {
    this.assertOpen();
    const record = this.require(taskId);
    if (record.continuing || record.task.state.status !== "settled") throw new Error("Task must settle before continuation");
    if (record.fault) throw record.fault;
    record.continuing = true;
    try {
      const operationId = await record.driver.accept(input);
      this.assertOpen();
      record.task = reduceTask(record.task, { type: "continue", operationId });
      record.scheduled = true;
      this.drain();
      return record.task;
    } finally {
      record.continuing = false;
    }
  }

  async queue(taskId: string, kind: "steer" | "followUp", input: TaskInput): Promise<string> {
    this.assertOpen();
    const entryId = await this.require(taskId).driver.queue(kind, input);
    this.notify();
    return entryId;
  }

  async cancelQueued(taskId: string, entryId: string) {
    this.assertOpen();
    const result = await this.require(taskId).driver.cancelQueued(entryId);
    this.notify();
    return result;
  }

  async takeOver(taskId: string): Promise<void> {
    this.assertOpen();
    const record = this.require(taskId);
    // Suppress writes immediately, including a delivery attempt waiting on native storage.
    record.task = reduceTask(record.task, { type: "takeover" });
    try { await record.driver.store.takeOver(); } catch (error) {
      record.fault = error;
      throw error;
    } finally { this.notify(); }
  }

  async requestAbort(taskId: string): Promise<void> {
    this.assertOpen();
    const record = this.require(taskId);
    const operationId = record.task.operationId;
    await record.driver.requestAbort(operationId);
    record.task = reduceTask(record.task, { type: "cancel_requested", operationId });
    record.scheduled = !record.driving;
    this.drain();
  }

  /** Cancelling this observation never cancels the native operation or releases quota. */
  wait(taskId: string, signal?: AbortSignal): Promise<Task> {
    const operationId = this.require(taskId).task.operationId;
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.listeners.delete(check); signal?.removeEventListener("abort", check); };
      const check = () => {
        const record = this.require(taskId);
        const error = signal?.aborted ? signal.reason ?? new Error("Task observation aborted")
          : this.closing ? new Error("Task engine is closed") : record.fault;
        if (error) { cleanup(); reject(error); return; }
        if (record.task.operationId !== operationId) { cleanup(); reject(new Error("Task operation changed")); return; }
        if (record.task.state.status === "settled" || record.task.control === "manual") { cleanup(); resolve(record.task); }
      };
      this.listeners.add(check);
      signal?.addEventListener("abort", check, { once: true });
      check();
    });
  }

  async deliverSelection(taskId: string, selected: readonly ExecutionMessage[]): Promise<string> {
    this.assertOpen();
    const record = this.require(taskId);
    const text = selected.map(message => `[${message.role}]\n${message.text}`).join("\n\n").trim();
    if (!text || selected.length === 0) throw new Error("Select at least one existing message");
    const delivery: TaskDelivery = {
      deliveryId: `selection:${randomUUID()}`, taskId, operationId: record.task.operationId,
      parent: record.driver.store.binding.parent, kind: "selection",
      status: record.task.state.status === "settled" ? record.task.state.outcome.status : "completed",
      text, sourceEntryIds: selected.map(message => message.entryId), createdAt: Date.now(),
    };
    await record.driver.store.saveDelivery(delivery);
    await this.flushDeliveries();
    return delivery.deliveryId;
  }

  /** Called on completion and parent lifecycle changes; there is no reconciliation timer. */
  flushDeliveries(): Promise<void> {
    this.assertOpen();
    if (this.flushing) { this.flushAgain = true; return this.flushing; }
    this.flushing = (async () => {
      const failures: unknown[] = [];
      do {
        this.flushAgain = false;
        for (const record of this.records.values()) {
          if (this.closing) return;
          try {
            for (const stored of await record.driver.store.deliveries()) {
              if (stored.receipt) continue;
              const attempt = await this.delivery.deliver(stored.delivery, () => !this.closing && !record.fault
                && (stored.delivery.kind === "selection" || record.task.control === "autonomous"));
              if (attempt.status === "received") await record.driver.store.acknowledge(attempt.receipt);
            }
            record.deliveryError = undefined;
          } catch (error) {
            record.deliveryError = error;
            failures.push(error);
          }
        }
      } while (this.flushAgain && !this.closing);
      this.notify();
      if (failures.length) throw new AggregateError(failures, "Parent result delivery failed; durable results are retained");
    })().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      this.notify();
      await this.flushing?.catch(() => { /* Delivery errors remain observable; teardown still closes execution resources. */ });
      const drivers = new Set([...this.records.values()].map(record => record.driver).concat([...this.accepting.values()]));
      const results = await Promise.allSettled([...drivers].map(driver => driver.close()));
      await Promise.allSettled([...this.records.values()].flatMap(record => record.driving ? [record.driving] : []));
      this.listeners.clear();
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Task engine cleanup failed");
    });
    return this.closing;
  }

  private record(driver: ExecutionDriver, operationId: string): TrackedTask {
    const binding = driver.store.binding;
    let task = createTask(binding.taskId, operationId, binding.policy);
    if (binding.control === "manual") task = reduceTask(task, { type: "takeover" });
    return { driver, task, scheduled: false };
  }

  private drain(): void {
    if (this.closing) return;
    for (const record of this.records.values()) {
      if (!record.scheduled || record.driving || record.fault || record.task.state.status === "settled") continue;
      // A durable abort seals provider/tool admission; reconciliation itself needs no provider slot.
      const release = record.task.state.status === "cancelling" ? () => {} : this.quota.tryAcquire(record.task.policy.model);
      if (!release) continue;
      record.scheduled = false;
      const operationId = record.task.operationId;
      record.task = reduceTask(record.task, { type: "started", operationId });
      record.driving = Promise.resolve().then(async () => {
        const outcome = await record.driver.drive(operationId);
        if (this.closing) return;
        if (outcome.kind === "settled") await this.complete(record, outcome.result);
        else record.task = reduceTask(record.task, { type: "waiting", operationId });
      }).catch(error => { if (!this.closing) record.fault = error; }).finally(() => {
        release();
        record.driving = undefined;
        this.notify();
        this.drain();
        if (!this.closing) {
          // The outbox owns delivery failures independently of a successfully completed execution.
          void this.flushDeliveries().catch(() => {});
        }
      });
    }
    this.notify();
  }

  private async complete(record: TrackedTask, result: ExecutionResult): Promise<void> {
    if (result.operationId !== record.task.operationId) return;
    if (record.driver.store.binding.mode === "background" && record.task.control === "autonomous") {
      const outcome = result.outcome;
      await record.driver.store.saveDelivery({
        deliveryId: `automatic:${record.task.taskId}:${result.operationId}`, taskId: record.task.taskId,
        operationId: result.operationId, parent: record.driver.store.binding.parent, kind: "automatic", status: outcome.status,
        text: outcome.status === "error" ? `${outcome.error}${outcome.result ? `\n\n${outcome.result}` : ""}`
          : outcome.result || `Subagent ${outcome.status}.`,
        sourceEntryIds: result.sourceEntryIds, createdAt: result.completedAt,
      });
    }
    record.task = reduceTask(record.task, { type: "settled", operationId: result.operationId, outcome: result.outcome });
  }

  private claim(driver: ExecutionDriver): void {
    this.assertOpen();
    const taskId = driver.store.binding.taskId;
    if (this.records.has(taskId) || this.accepting.has(taskId)) throw new Error(`Task already attached: ${taskId}`);
    this.accepting.set(taskId, driver);
  }

  private require(taskId: string): TrackedTask {
    const record = this.records.get(taskId);
    if (!record) throw new Error(`Unknown task: ${taskId}`);
    return record;
  }

  private assertOpen(): void { if (this.closing) throw new Error("Task engine is closed"); }
  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch (error) {
        console.error("[subagents] Task observer failed:", error);
      }
    }
  }
}
