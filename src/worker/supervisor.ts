import { fork, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { createProcessTree } from "./process-tree.js";

let tree: ReturnType<typeof createProcessTree> | undefined;
let worker: ChildProcess | undefined;
let stopping: Promise<boolean> | undefined;
let exited: Promise<void> = Promise.resolve();
let stderr = "";
let released = false;

function send(message: unknown): void {
  if (process.connected) process.send!(message, error => { if (error) void stop(error.message, true); });
}

function release(): void {
  if (released) return;
  released = true;
  tree?.close();
  process.exit(0);
}

function stop(reason: string, force = false): Promise<boolean> {
  stopping ??= Promise.resolve().then(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      if (force || !worker.connected) worker.kill("SIGKILL");
      else {
        worker.send({ type: "shutdown" }, error => { if (error) worker?.kill("SIGKILL"); });
        timer = setTimeout(() => worker?.kill("SIGKILL"), 2000);
      }
    }
    await exited;
    if (timer) clearTimeout(timer);
    await tree?.drain();
    send({ type: "stopped", error: reason, stderr });
    if (!process.connected) release();
    return true;
  }).catch(error => {
    // A failed cleanup cannot authorize handoff or release the storage lease.
    send({ type: "supervision_error", error: String(error) });
    return false;
  });
  return stopping;
}

process.on("message", (message: any) => {
  if (message?.type === "start") {
    if (tree || worker || typeof message.path !== "string" || !isAbsolute(message.path)) {
      void stop("Invalid supervisor startup", true); return;
    }
    try {
      tree = createProcessTree(message.path);
      worker = fork(new URL("./main.mjs", import.meta.url), [], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "json" });
      const done = Promise.withResolvers<void>();
      exited = done.promise;
      worker.on("error", error => { done.resolve(); void stop(error.message, true); });
      worker.on("exit", (code, signal) => {
        done.resolve(); void stop(`Worker exited (${signal ?? code})`, true);
      });
      worker.on("disconnect", () => { void stop("Worker IPC disconnected", true); });
      worker.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
      worker.on("message", value => { if (!stopping) send({ type: "worker", message: value }); });
      if (!worker.pid) throw new Error("Worker process did not start");
      tree.attach(worker.pid);
      send({ type: "started", pid: worker.pid });
    } catch (error) { void stop(String(error), true); }
  } else if (message?.type === "shutdown") {
    void stop("Worker shutdown");
  } else if (message?.type === "terminate") {
    void stop(typeof message.error === "string" ? message.error : "Worker terminated", true);
  } else if (message?.type === "release") {
    void stop("Worker shutdown").then(cleaned => { if (cleaned) release(); });
  } else if (!stopping && worker?.connected) {
    worker.send(message, error => { if (error) void stop(error.message, true); });
  }
});
process.on("disconnect", () => { void stop("Parent disconnected").then(cleaned => { if (cleaned && !process.connected) release(); }); });
process.on("uncaughtException", error => { void stop(String(error), true); });
process.on("unhandledRejection", error => { void stop(String(error), true); });
