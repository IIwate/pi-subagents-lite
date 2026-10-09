import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { WorkerExecutionDriver } from "../../../src/drivers/worker-driver.js";
import { FileLockManager } from "../../../src/drivers/file-locks.js";
import { TaskEngine } from "../../../src/engine/task-engine.js";
import { PiDeliveryChannel } from "../../../src/drivers/pi-delivery-channel.js";
import type { WorkerBootstrap, WorkerMethods } from "../../../src/worker/protocol.js";
import { createTestHarness, type TestHarness } from "../../support/harness.js";
import { createRuntimeHost, resultEntries, settled, spawn } from "../../support/runtime.js";

const extension = fileURLToPath(new URL("../../support/worker-extension.ts", import.meta.url));
const entry = fileURLToPath(new URL("../../../src/index.ts", import.meta.url));
const shell = process.platform === "win32" ? "powershell" : "bash";

describe.skipIf(process.platform !== "linux" && process.platform !== "win32")("Supervised durable workers", () => {
  let resources: TestHarness;
  let directory: string;
  let locks: FileLockManager;
  beforeEach(() => { resources = createTestHarness(); directory = resources.createTempDir("pi-worker-"); locks = new FileLockManager(); });
  afterEach(() => resources.dispose());

  async function serve(handle: (path: string, body: any) => unknown | Promise<unknown>) {
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const result = await handle(request.url!, JSON.parse(Buffer.concat(chunks).toString()));
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
      } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); }
    });
    resources.onDispose(async () => {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address() as { port: number };
    const endpoint = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("PI_WORKER_TEST_ENDPOINT", endpoint);
    vi.stubEnv("PI_WORKER_TEST_PROVIDER", "isolated-worker");
    return endpoint;
  }

  function bootstrap(name: string, fusion = false): WorkerBootstrap {
    writeFileSync(join(directory, "settings.json"), JSON.stringify({ extensions: [extension], retry: { enabled: false }, compaction: { enabled: false } }));
    const model = fauxProvider({ provider: "isolated-worker", api: "isolated-worker", models: [{ id: "child" }] }).getModel();
    const path = join(directory, `${name}.worker.sqlite`);
    return { path, parentSessionId: "parent", agentDir: directory, extensionEntryPath: entry,
      create: { path, binding: { taskId: name, parent: { sessionId: "parent", entryId: "origin" }, mode: "background", control: "autonomous",
        policy: { agent: "worker", model: { provider: model.provider, id: model.id }, thinkingLevel: "off", cwd: directory,
          tools: [], systemPrompt: "", limits: { graceTurns: 1 } },
        execution: { backend: "worker", model, observationPacking: false, actionFusion: fusion, requireRegisteredProvider: true, settings: {} },
      }, resources: { agentDir: directory, cwd: directory, projectTrusted: true, model, thinking: "off", actionFusion: fusion,
        extensionEntryPath: entry, policy: { definition: { name: "worker", description: "Offline worker", systemPrompt: "Complete the delegated task.", mcp: false },
          registeredTools: ["read", "write", shell], restrictToRegisteredTools: false, tools: ["read", "write", shell],
          extensions: true, skills: false, systemPromptMode: "replace", includeContextFiles: false, parentModelKey: `${model.provider}/${model.id}` },
      } } };
  }

  async function open(options: WorkerBootstrap) {
    const driver = await WorkerExecutionDriver.open(options, { locks, warn: () => {} });
    resources.onDispose(() => driver.close());
    return driver;
  }

  function engine() {
    const tasks = new TaskEngine({ default: 1 }, { deliver: async () => ({ status: "pending", reason: "busy" }) });
    resources.onDispose(() => tasks.close()); return tasks;
  }

  function loseReply(driver: WorkerExecutionDriver, method: keyof WorkerMethods) {
    const rpc = driver["rpc"];
    const receive = rpc.receive.bind(rpc);
    let dropped = false;
    vi.spyOn(rpc, "receive").mockImplementation(async (raw: any) => {
      if (!dropped && raw?.type === "response" && rpc["pending"].get(raw.id)?.method === method) {
        dropped = true;
        driver["supervisor"].send({ type: "terminate", error: `Lost ${method} response` });
        return;
      }
      await receive(raw);
    });
  }

  it("recovers accepted and withdrawn request identities without starting a model", async () => {
    vi.stubEnv("NODE_OPTIONS", "--require=worker-must-not-inherit-parent-loader");
    let calls = 0;
    await serve(path => { if (path === "/model") calls++; return { action: "idle" }; });
    const options = bootstrap("identities");
    const first = await open(options);
    const operation = await first.accept({ text: "Accept once" }, "accepted-input");
    loseReply(first, "queue");
    const queued = await first.queue("steer", { text: "Withdraw once" }, "queued-input");
    expect(await first.cancelQueued(queued)).toBe("cancelled");
    await first.close();
    const restored = await open({ ...options, create: undefined });
    expect(await restored.accept({ text: "Accept once" }, "accepted-input")).toBe(operation);
    expect(await restored.queue("steer", { text: "Withdraw once" }, "queued-input")).toBe(queued);
    expect((await restored.snapshot()).queued).toEqual([]);
    expect((await restored.snapshot()).lastResult?.operationId).toBe(operation);
    await expect(restored.queue("followUp", { text: "Different input" }, "queued-input")).rejects.toThrow("different queued input");
    expect(calls).toBe(0);
  }, 20000);

  it("recovers a committed answer after its IPC response is lost", async () => {
    let calls = 0;
    await serve(path => path === "/control" ? { action: "idle" } : (++calls, fauxAssistantMessage("Committed answer")));
    const child = await open(bootstrap("committed"));
    const operation = await child.accept({ text: "Return an answer" });
    loseReply(child, "drive");
    expect(await child.drive(operation)).toMatchObject({ kind: "settled", result: { operationId: operation,
      outcome: { status: "completed", result: "Committed answer" } } });
    expect((await child.snapshot()).messages.at(-1)?.text).toBe("Committed answer");
    expect(calls).toBe(1);
  }, 15000);

  it.each(["abort", "spoof"])("reaps detached descendants before releasing locks and quota after %s", async action => {
    const control = Promise.withResolvers<{ action: string }>();
    const controllerReady = Promise.withResolvers<number>();
    const treeReady = Promise.withResolvers<{ pid: number; child: number }>();
    const treeResponse = Promise.withResolvers<object>();
    resources.onDispose(() => { control.resolve({ action: "idle" }); treeResponse.resolve({}); });
    let firstPid: number | undefined;
    let descendants: { pid: number; child: number };
    const file = join(directory, "shared.txt");
    const quote = (value: string) => process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
    const script = fileURLToPath(new URL("../../support/worker-process-tree.cjs", import.meta.url));
    const endpoint = await serve((path, body) => {
      if (path === "/control") {
        if (firstPid === undefined) { firstPid = body.pid; controllerReady.resolve(body.pid); return control.promise; }
        return { action: "idle" };
      }
      if (path === "/tree") { treeReady.resolve(body); return treeResponse.promise; }
      if (body.pid === firstPid) return fauxAssistantMessage(fauxToolCall("write", { path: file, content: "First worker",
        then_run: { command: `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(script)} ${quote(endpoint)}` } }), { stopReason: "toolUse" });
      expect(() => process.kill(descendants.pid, 0)).toThrow();
      expect(() => process.kill(descendants.child, 0)).toThrow();
      return fauxAssistantMessage("Next task completed");
    });
    const first = await open(bootstrap("crash", true));
    await controllerReady.promise;
    const next = await open(bootstrap("next"));
    const tasks = engine();
    await tasks.accept(first, { text: "Hold the fused command" });
    descendants = await treeReady.promise;
    const unlock = locks.release.bind(locks);
    const released = vi.spyOn(locks, "release").mockImplementation(async lease => {
      expect(() => process.kill(descendants.pid, 0)).toThrow();
      expect(() => process.kill(descendants.child, 0)).toThrow();
      await unlock(lease);
    });
    await tasks.accept(next, { text: "Wait for the released quota" });
    expect(tasks.get("next").state.status).toBe("queued");
    const waitingLease = locks.acquire(file);
    resources.onDispose(async () => { await first.close(); await locks.release(await waitingLease); });
    control.resolve({ action });
    const result = await tasks.wait("crash");
    expect(result.state).toMatchObject({ status: "settled", outcome: { status: "error", error: expect.stringContaining("Worker crashed") } });
    await waitingLease;
    expect(released).toHaveBeenCalledOnce();
    expect((await tasks.wait("next")).state).toMatchObject({ status: "settled", outcome: { status: "completed" } });
  }, 25000);

  it.each(["before", "after"] as const)("keeps takeover ordering when control changes %s completion", async position => {
    const entered = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
    resources.onDispose(() => answer.resolve(fauxAssistantMessage("Final answer")));
    await serve(path => {
      if (path === "/control") return { action: "idle" };
      entered.resolve(); return answer.promise;
    });
    const child = await open(bootstrap(`takeover-${position}`));
    const tasks = engine();
    await tasks.accept(child, { text: "Wait for control" });
    await entered.promise;
    if (position === "before") await tasks.takeOver(child.store.binding.taskId);
    answer.resolve(fauxAssistantMessage("Final answer"));
    await settled(resources, { engine: tasks }, child.store.binding.taskId);
    if (position === "after") await tasks.takeOver(child.store.binding.taskId);
    const deliveries = await child.store.deliveries();
    expect(deliveries).toHaveLength(position === "before" ? 0 : 1);
    expect(child.store.binding.control).toBe("manual");
    expect((await child.snapshot()).messages.at(-1)?.text).toBe("Final answer");
  }, 15000);

  it("keeps a verified parent receipt unique when the ACK route disconnects", async () => {
    await serve(path => path === "/control" ? { action: "idle" } : fauxAssistantMessage("Durable parent result"));
    const parent = await createRuntimeHost(resources, "isolation", "tools: [read]\nextensions: true\nskills: false");
    vi.stubEnv("PI_WORKER_TEST_PROVIDER", parent.worker.provider.id);
    writeFileSync(join(parent.directory, "settings.json"), JSON.stringify({ extensions: [extension], retry: { enabled: false }, compaction: { enabled: false } }));
    parent.runtime.store.mutate.experimental.setExecutionBackend("worker");
    parent.parentProvider.setResponses([fauxAssistantMessage("Parent received the result")]);
    const deliver = PiDeliveryChannel.prototype.deliver;
    let disconnected = false;
    vi.spyOn(PiDeliveryChannel.prototype, "deliver").mockImplementation(async function (this: PiDeliveryChannel, delivery, eligible) {
      const result = await deliver.call(this, delivery, eligible);
      if (result.status === "received" && !disconnected) {
        disconnected = true;
        const child = parent.runtime.engine["records"].get(delivery.taskId)!.driver as WorkerExecutionDriver;
        child["terminate"](new Error("ACK route disconnected"));
      }
      return result;
    });
    const task = await spawn(parent, "Produce the isolated result");
    await settled(resources, parent.runtime, task.taskId);
    await parent.runtime.flushDeliveries();
    await parent.runtime.flushDeliveries();
    expect(disconnected).toBe(true);
    expect(resultEntries(parent)).toHaveLength(1);
    await parent.runtime.engine.takeOver(task.taskId);
    expect(resultEntries(parent)).toHaveLength(1);
    expect((await parent.runtime.engine.storedDeliveries(task.taskId))[0].receipt).toBeDefined();
  }, 20000);
});
