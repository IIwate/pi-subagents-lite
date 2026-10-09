import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { WorkerRpc, type WireMessage, type WorkerBootstrap } from "./protocol.js";
import type { DurableDriver } from "../drivers/durable-driver.js";
import type { FileLocks } from "../drivers/file-locks.js";
import type { TaskBootstrap } from "../drivers/task-bootstrap.js";

let driver: DurableDriver | undefined;
let initializing: Promise<void> | undefined;
let closing: Promise<void> | undefined;
let notified = false;
const lifetime = new AbortController();

function send(message: WireMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected) { reject(new Error("Worker IPC is closed")); return; }
    process.send!(message, error => error ? reject(error) : resolve());
  });
}

function current(): DurableDriver {
  if (!driver || closing) throw new Error("Worker execution is unavailable");
  return driver;
}

const locks: FileLocks = {
  async acquire(path, signal) {
    signal?.throwIfAborted();
    const requestId = randomUUID();
    const cancel = () => { void rpc.call("cancelLock", { requestId }).catch(() => { /* Disconnect cleanup owns any pending lease. */ }); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const lease = await rpc.call("acquireLock", { path }, requestId);
      if (signal?.aborted) { await locks.release(lease); signal.throwIfAborted(); }
      return lease;
    } finally { signal?.removeEventListener("abort", cancel); }
  },
  async release(leaseId) { await rpc.call("releaseLock", { leaseId }); },
};

async function initialize(options: WorkerBootstrap): Promise<void> {
  const [{ openTask }, { NativeTaskStore, parseBinding }, { createSession }, { openNodeSqliteStorage }, { BACKGROUND_CONTEXT }] = await Promise.all([
    import("../drivers/task-bootstrap.js"), import("../drivers/native-task-store.js"), import("@earendil-works/pi-durable"),
    import("@earendil-works/pi-durable/storage/sqlite/node"), import("@earendil-works/chord/context"),
  ]);
  let bootstrap: TaskBootstrap;
  if (options.create) {
    const binding = parseBinding(options.create.binding);
    if (binding.parent.sessionId !== options.parentSessionId || binding.execution?.backend !== "worker"
      || binding.policy.cwd !== options.create.resources.cwd) throw new Error("Worker bootstrap identity mismatch");
    bootstrap = { ...options.create, binding };
  } else {
    const session = createSession(await openNodeSqliteStorage(options.path));
    let binding;
    try { binding = (await NativeTaskStore.open(session, undefined, options.path)).binding; }
    finally { await session.close(BACKGROUND_CONTEXT); }
    if (binding.parent.sessionId !== options.parentSessionId || binding.execution?.backend !== "worker") {
      throw new Error("Worker task belongs to another parent or backend");
    }
    bootstrap = { path: options.path, resources: {
      agentDir: options.agentDir, cwd: binding.policy.cwd, projectTrusted: binding.resources!.trusted,
      model: binding.execution.model, thinking: binding.policy.thinkingLevel, restored: binding,
      observationPacking: binding.execution.observationPacking, actionFusion: binding.execution.actionFusion,
      extensionEntryPath: options.extensionEntryPath,
    } };
  }
  lifetime.signal.throwIfAborted();
  driver = await openTask(bootstrap, {
    exec: (command, args, opts) => new Promise(resolve => {
      execFile(command, args, { ...opts, cwd: opts?.cwd ?? bootstrap.resources.cwd, encoding: "utf8" }, (error, stdout, stderr) => {
        resolve({ stdout, stderr, code: error ? typeof error.code === "number" ? error.code : 1 : 0, killed: error?.killed ?? false });
      });
    }),
    warn: text => { void send({ type: "event", name: "warning", text }).catch(() => { /* Shutdown owns a disconnected parent. */ }); },
    signal: lifetime.signal, fusedFileQueue: locks,
  });
  await driver.observe(() => {
    if (notified || closing) return;
    notified = true;
    void send({ type: "event", name: "changed" }).catch(() => { void shutdown(); });
  });
}

const rpc = new WorkerRpc(send, {
  init: async options => {
    if (initializing || closing) throw new Error("Worker is already initialized");
    initializing = initialize(options);
    await initializing;
    return { binding: current().store.binding, snapshot: await current().snapshot() };
  },
  accept: async ({ input, requestId }) => current().accept(input, requestId),
  drive: async ({ operationId }) => current().drive(operationId),
  abort: async ({ operationId, stoppedBy }) => { await current().requestAbort(operationId, stoppedBy); return null; },
  queue: async ({ kind, input, requestId }) => current().queue(kind, input, requestId),
  cancelQueued: async ({ entryId }) => current().cancelQueued(entryId),
  snapshot: async () => { notified = false; return current().snapshot(); },
  takeOver: async () => { await current().store.takeOver(); return null; },
  saveDelivery: async delivery => { await current().store.saveDelivery(delivery); return null; },
  deliveries: async () => current().store.deliveries(),
  acknowledge: async receipt => { await current().store.acknowledge(receipt); return null; },
}, () => { throw new Error("Unexpected parent event"); });

function shutdown(): Promise<void> {
  closing ??= Promise.resolve().then(async () => {
    lifetime.abort(new Error("Worker is closing"));
    try { await initializing; } catch { /* Initialization already reports its error through the request. */ }
    await driver?.close();
    rpc.close(new Error("Worker is closed"));
    process.exit(0);
  }).catch(error => { console.error(String(error)); process.exit(1); });
  return closing;
}

process.on("message", (message: any) => {
  if (message?.type === "shutdown") { void shutdown(); return; }
  void rpc.receive(message).catch(error => { console.error(String(error)); void shutdown(); });
});
process.on("disconnect", () => { void shutdown(); });
process.on("uncaughtException", error => { console.error(String(error)); process.exit(1); });
process.on("unhandledRejection", error => { console.error(String(error)); process.exit(1); });
