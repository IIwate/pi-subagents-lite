import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, UsageDoc, type Session, type EntryRecord, type Cursor } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { DriveResult, ExecutionDriver, ExecutionSnapshot, TaskBinding, TaskInput, TaskStore } from "../engine/contracts.js";
import { NativeTaskStore, parseBinding } from "./native-task-store.js";
import { projectMessage } from "./message-projection.js";
import type { FileLocks } from "./file-locks.js";
import { WorkerRpc, type WireMessage, type WorkerBootstrap } from "../worker/protocol.js";

interface WorkerHost {
  locks?: FileLocks;
  warn(message: string): void;
  signal?: AbortSignal;
}

/** The supervisor retains storage ownership until the driver has closed its passive recovery view. */
export class WorkerExecutionDriver implements ExecutionDriver {
  readonly store: TaskStore;
  private supervisor!: ChildProcess;
  private readonly rpc: WorkerRpc;
  private readonly started = Promise.withResolvers<number>();
  private readonly stopped = Promise.withResolvers<Error>();
  private readonly exited = Promise.withResolvers<void>();
  private binding!: TaskBinding;
  private state!: ExecutionSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly leases = new Set<string>();
  private readonly lockWaiters = new Map<string, AbortController>();
  private session?: Session;
  private local?: NativeTaskStore;
  private recovery?: Promise<void>;
  private refreshing?: Promise<ExecutionSnapshot>;
  private dirty = false;
  private initialized = false;
  private terminating = false;
  private cleaned = false;
  private failure?: Error;
  private closing?: Promise<void>;

  private constructor(private readonly options: WorkerBootstrap, private readonly host: WorkerHost) {
    this.rpc = new WorkerRpc(message => this.send(message), {
      acquireLock: async ({ path }, requestId) => {
        if (this.terminating || !host.locks) throw new Error("Worker file locks are unavailable");
        const abort = new AbortController();
        this.lockWaiters.set(requestId, abort);
        try {
          const lease = await host.locks.acquire(path, abort.signal);
          this.leases.add(lease);
          if (this.cleaned) { await this.releaseLease(lease); throw new Error("Worker has exited"); }
          return lease;
        } finally { this.lockWaiters.delete(requestId); }
      },
      cancelLock: async ({ requestId }) => { this.lockWaiters.get(requestId)?.abort(new Error("File lock wait cancelled")); return null; },
      releaseLock: async ({ leaseId }) => { if (!this.terminating) await this.releaseLease(leaseId); return null; },
    }, event => {
      if (event.name === "warning") host.warn(event.text ?? "Worker warning");
      else { this.dirty = true; this.refresh(); }
    });
    const binding = () => this.binding;
    this.store = {
      get binding() { return binding(); },
      takeOver: async () => {
        await this.access(() => this.rpc.call("takeOver", null).then(() => undefined), store => store.takeOver());
        this.binding = Object.freeze({ ...this.binding, control: "manual" });
      },
      saveDelivery: async delivery => { await this.access(() => this.rpc.call("saveDelivery", delivery).then(() => undefined), store => store.saveDelivery(delivery)); },
      deliveries: () => this.access(() => this.rpc.call("deliveries", null), store => store.deliveries()),
      acknowledge: async receipt => { await this.access(() => this.rpc.call("acknowledge", receipt).then(() => undefined), store => store.acknowledge(receipt)); },
    };
  }

  static async open(options: WorkerBootstrap, host: WorkerHost): Promise<WorkerExecutionDriver> {
    const driver = new WorkerExecutionDriver(options, host);
    const abort = () => driver.terminate(new Error("Worker initialization aborted"));
    host.signal?.throwIfAborted();
    try {
      await driver.launch();
      host.signal?.addEventListener("abort", abort, { once: true });
      host.signal?.throwIfAborted();
      const ready = await driver.rpc.call("init", options);
      driver.binding = parseBinding(ready.binding);
      if (driver.binding.parent.sessionId !== options.parentSessionId || driver.binding.execution?.backend !== "worker") {
        throw new Error("Worker returned a different task binding");
      }
      driver.state = ready.snapshot;
      driver.initialized = true;
      host.signal?.throwIfAborted();
      return driver;
    } catch (error) { await driver.close(); throw error; }
    finally { host.signal?.removeEventListener("abort", abort); }
  }

  /** Passive reads acquire the same supervisor lease without loading extensions or a model. */
  static async readStored(options: WorkerBootstrap) {
    const guard = new WorkerExecutionDriver(options, { warn: () => {} });
    try {
      await guard.launch();
      guard.control({ type: "shutdown" });
      await guard.stopped.promise;
      guard.session = createSession(await openNodeSqliteStorage(options.path));
      const store = await NativeTaskStore.open(guard.session, undefined, options.path);
      if (store.binding.parent.sessionId !== options.parentSessionId || store.binding.execution?.backend !== "worker") {
        throw new Error("Stored worker belongs to another parent or backend");
      }
      return { binding: store.binding, result: await store.latestResult(), deliveries: await store.deliveries() };
    } finally { await guard.close(); }
  }

  private async launch(): Promise<void> {
    try {
      this.supervisor = fork(new URL("../../dist/worker/supervisor.mjs", import.meta.url), [], {
        execArgv: [], env: { ...process.env, NODE_OPTIONS: undefined },
        stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "json",
      });
    } catch (error) { this.didStop(error as Error); this.exited.resolve(); throw error; }
    let diagnostic = "";
    this.supervisor.stderr?.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-8192); });
    this.supervisor.on("error", error => {
      this.started.reject(error);
      if (!this.supervisor.pid) { this.didStop(error); this.exited.resolve(); }
      else this.terminate(error);
    });
    this.supervisor.on("exit", (code, signal) => {
      this.exited.resolve();
      if (!this.cleaned) {
        const error = new Error(`Worker supervisor exited before cleanup confirmation (${signal ?? code})${diagnostic ? `: ${diagnostic}` : ""}`);
        this.started.reject(error);
        this.failure = error;
        this.host.warn(error.message);
        // An unknown surviving process tree cannot release execution quota or locks.
        if (!this.initialized) this.didStop(error);
      }
    });
    this.supervisor.on("message", (message: any) => {
      if (message?.type === "started" && Number.isSafeInteger(message.pid) && message.pid > 0) this.started.resolve(message.pid);
      else if (message?.type === "stopped" && typeof message.error === "string") this.didStop(new Error(message.error));
      else if (message?.type === "supervision_error") { this.failure = new Error(String(message.error)); this.host.warn(this.failure.message); }
      else if (message?.type === "worker") void this.rpc.receive(message.message).catch(error => this.terminate(error));
      else this.terminate(new Error("Invalid supervisor message"));
    });
    this.control({ type: "start", path: this.options.path });
    await this.started.promise;
  }

  private control(message: object): void {
    if (this.supervisor?.connected) this.supervisor.send(message, error => { if (error) this.terminate(error); });
  }

  private send(message: WireMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const failed = (error: Error) => {
        this.terminate(error);
        void this.stopped.promise.then(() => reject(error));
      };
      if (!this.supervisor?.connected || this.terminating) { failed(this.failure ?? new Error("Worker IPC is closed")); return; }
      this.supervisor.send(message, error => error ? failed(error) : resolve());
    });
  }

  private terminate(error: Error): void {
    if (this.terminating) return;
    this.terminating = true;
    this.failure = error;
    this.control({ type: "terminate", error: error.message });
  }

  private didStop(error: Error): void {
    if (this.cleaned) return;
    this.terminating = true;
    this.cleaned = true;
    this.failure ??= error;
    this.started.reject(error);
    for (const abort of this.lockWaiters.values()) abort.abort(error);
    this.stopped.resolve(this.failure);
    this.rpc.close(this.failure);
    if (this.initialized && !this.closing) {
      void this.recover().then(() => this.notify(), failure => this.host.warn(String(failure)));
    }
  }

  private async releaseLease(leaseId: string): Promise<void> {
    if (!this.leases.delete(leaseId)) return;
    await this.host.locks!.release(leaseId);
  }

  private recover(): Promise<void> {
    this.recovery ??= (async () => {
      const error = await this.stopped.promise;
      await Promise.all([...this.leases].map(lease => this.releaseLease(lease)));
      this.session = createSession(await openNodeSqliteStorage(this.options.path));
      this.local = await NativeTaskStore.open(this.session, undefined, this.options.path);
      this.binding = this.local.binding;
      let result = await this.local.latestResult();
      const operation = await this.local.currentOperation();
      const root = await this.session.commit(async tx => (await tx.scanConversations({}, 1)).items[0], BACKGROUND_CONTEXT);
      if (!result && operation && root) result = await this.local.result(operation.id, root.id, `Worker crashed: ${error.message}`);
      const entries: EntryRecord[] = [];
      let cursor: Cursor | undefined;
      if (root) do {
        const page = await this.session.commit(tx => tx.scanEntries({ conversationId: root.id }, 256, cursor), BACKGROUND_CONTEXT);
        entries.push(...page.items); cursor = page.next;
      } while (cursor !== undefined);
      entries.sort((a, b) => a.id - b.id);
      const messages = entries.flatMap(entry => (entry.model ?? []).map(message => projectMessage(String(entry.id), message)));
      const usage = root ? await this.session.snapshot(UsageDoc, root.id, BACKGROUND_CONTEXT) : undefined;
      const totals = [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})];
      const assistants = entries.flatMap(entry => entry.model ?? []).filter((message): message is AssistantMessage => message.role === "assistant");
      const last = assistants.at(-1);
      const window = this.binding.execution?.model.contextWindow;
      this.state = { lastResult: result, messages, faulted: true,
        stats: { input: totals.reduce((n, item) => n + item.input, 0), output: totals.reduce((n, item) => n + item.output, 0),
          cost: totals.reduce((n, item) => n + item.cost.total, 0), toolUses: messages.filter(item => item.role === "toolResult").length,
          turnCount: entries.filter(entry => (operation?.fromEntryId == null || entry.id > operation.fromEntryId) && entry.model?.some(message => message.role === "assistant" && !["error", "aborted", "pending", "deferred"].includes(message.stopReason))).length,
          compactions: entries.filter(entry => entry.kind === "pi.compaction").length,
          contextPercent: last && window ? (last.usage.input + last.usage.cacheRead + last.usage.cacheWrite + last.usage.output) / window * 100 : null },
        queued: (await this.local.pending()).map(item => ({ entryId: item.id, kind: item.kind, ...item.input })),
      };
    })();
    return this.recovery;
  }

  private async access<T>(remote: () => Promise<T>, local: (store: NativeTaskStore) => Promise<T>): Promise<T> {
    if (this.closing) throw new Error("Worker driver is closed");
    if (!this.terminating) {
      try { return await remote(); } catch (error) { if (this.closing || !this.terminating) throw error; }
    }
    await this.recover();
    return local(this.local!);
  }

  accept(input: TaskInput, requestId: string = randomUUID()): Promise<string> {
    return this.access(() => this.rpc.call("accept", { input, requestId }), async store => {
      if (!Object.hasOwn(await store.operations(), requestId)) throw this.failure;
      return store.accept(input, null, requestId);
    });
  }

  drive(operationId: string): Promise<DriveResult> {
    return this.access(() => this.rpc.call("drive", { operationId }), async store => {
      const result = (await store.operations())[operationId]?.result;
      if (!result) throw this.failure;
      return { kind: "settled", result };
    });
  }

  async requestAbort(operationId: string, stoppedBy?: "user" | "agent"): Promise<void> {
    await this.access(() => this.rpc.call("abort", { operationId, stoppedBy }).then(() => undefined), store => store.recordStop(operationId, stoppedBy));
  }

  queue(kind: "steer" | "followUp", input: TaskInput, requestId: string = randomUUID()): Promise<string> {
    return this.access(() => this.rpc.call("queue", { kind, input, requestId }), async store => {
      if (!Object.hasOwn((await store.data()).inputs ?? {}, requestId)) throw this.failure;
      return store.enqueue(kind, input, requestId);
    });
  }

  cancelQueued(entryId: string): Promise<"cancelled" | "already_consumed" | "not_found"> {
    return this.access(() => this.rpc.call("cancelQueued", { entryId }), async store => {
      if (await store.removePending(entryId)) return "cancelled";
      return Object.hasOwn((await store.data()).inputs ?? {}, entryId) ? "already_consumed" : "not_found";
    });
  }

  snapshot(): Promise<ExecutionSnapshot> {
    this.refreshing ??= this.access(() => this.rpc.call("snapshot", null), async () => this.state)
      .then(state => { this.state = state; return state; }).finally(() => { this.refreshing = undefined; if (this.dirty) this.refresh(); });
    return this.refreshing;
  }

  private refresh(): void {
    if (!this.initialized || this.closing || this.refreshing) return;
    this.dirty = false;
    void this.snapshot().then(() => this.notify(), error => { if (!this.closing) this.host.warn(String(error)); });
  }

  async observe(listener: () => void): Promise<() => void> {
    if (this.closing) throw new Error("Worker driver is closed");
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { this.host.warn(`Worker observer failed: ${error}`); }
    }
  }

  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      this.listeners.clear();
      this.terminating = true;
      if (!this.cleaned) { this.control({ type: "shutdown" }); await this.stopped.promise; }
      const failures: unknown[] = [];
      try { await this.recovery; } catch (error) { failures.push(error); }
      try { await this.session?.close(BACKGROUND_CONTEXT); } catch (error) { failures.push(error); }
      const releases = await Promise.allSettled([...this.leases].map(lease => this.releaseLease(lease)));
      failures.push(...releases.flatMap(result => result.status === "rejected" ? [result.reason] : []));
      this.control({ type: "release" });
      await this.exited.promise;
      if (failures.length) throw new AggregateError(failures, "Worker cleanup failed");
    });
    return this.closing;
  }
}
