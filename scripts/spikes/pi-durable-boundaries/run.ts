import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Type, fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { Harness, createRegistry, defineExtension, defineTask, defineDoc, configure, AssistantEntry, hook, ToolTask } from "@earendil-works/pi-durable";
import { createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

assert(process.env.SPIKE_PROJECT, "Set SPIKE_PROJECT to the repository root");
const project = resolve(process.env.SPIKE_PROJECT);
const versions = Object.fromEntries(["pi-coding-agent", "pi-durable", "pi-ai", "chord"].map(name => {
  const version = JSON.parse(readFileSync(new URL(`node_modules/@earendil-works/${name}/package.json`, import.meta.url), "utf8")).version;
  assert.equal(version, "1.0.0", `Unexpected ${name} version`);
  return [name, version];
}));
const directory = mkdtempSync(join(tmpdir(), "pi-durable-run-"));
// Load the existing adapters against this isolated Pi 1.0 dependency tree.
for (const [source, target] of [["src/drivers/pi-delivery-channel.ts", "delivery.ts"], ["src/domain/quota.ts", "quota.ts"]]) {
  const original = readFileSync(join(project, source), "utf8");
  const content = original.replace('"../engine/contracts.js"', JSON.stringify(join(project, "src/engine/contracts.ts")))
    .replace('"./policy.js"', JSON.stringify(join(project, "src/domain/policy.ts")));
  writeFileSync(new URL(target, import.meta.url), content);
}
const { PiDeliveryChannel } = await import(new URL("delivery.ts", import.meta.url).href);
const { Quota } = await import(new URL("quota.ts", import.meta.url).href);
const context = BACKGROUND_CONTEXT;
const events: any[] = [];
const checks: string[] = [];
const log = (event: string, detail: object = {}) => { events.push({ event, ...detail }); };
const pass = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
const deferred = () => Promise.withResolvers<void>();
const text = (message: any): string => typeof message?.content === "string" ? message.content
  : (message?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
const terminal = () => ({ status: "terminal" as const, outcome: { status: "completed" as const, result: null } });
const Anchor = defineTask({ name: "spike.anchor", version: 1, initial: () => ({ phase: "done" }),
  phases: { done: (_task: any, api: any, ctx: any) => api.commit(terminal, ctx) },
  abort: (_task: any, api: any, ctx: any) => api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx) });
const Binding = defineDoc<any>({ kind: "spike.binding", version: 1, scope: "session", initial: () => ({}) });
const quota = new Quota({ default: 2, providers: { child: 2 } });
const identity = { provider: "child", id: "worker" };
const profiles = new Map<string, any>();
const children = new Map<string, any>();
const allChildren: any[] = [];
const errors: any[] = [];
let api: any;
let parentContext: any;
let parent: any;
let settings: any;
let channel: any;
let runtime: any;
let failAck = false;
let parentFactory: any;
const parentProvider = fauxProvider({ provider: "parent", api: "parent", tokensPerSecond: 100000, models: [{ id: "main" }] });
const workerProvider = fauxProvider({ provider: "child", api: "child", tokensPerSecond: 100000, models: [{ id: "worker" }] });
// Each request is routed by the exact task instruction rather than a global response ordering.
workerProvider.setResponses(Array.from({ length: 100 }, () => (request: any) => {
  const input = request.messages.find((message: any) => message.role === "user");
  const name = text(input).match(/TASK ([a-z-]+)/)?.[1];
  const profile = profiles.get(name!);
  assert(profile, `Unknown scripted task: ${name}`);
  const results = request.messages.filter((message: any) => message.role === "toolResult");
  log("model", { name, tools: (request.tools ?? []).map((tool: any) => tool.name) });
  if (results.length === 0) return fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), { stopReason: "toolUse" });
  const read = results.find((message: any) => message.toolName === "read");
  if (profile.write && !results.some((message: any) => message.toolName === "write")) {
    return fauxAssistantMessage(fauxToolCall("write", { path: "output.txt", content: text(read) }), { stopReason: "toolUse" });
  }
  return fauxAssistantMessage(`TASK ${name}: ${text(read)}; write=${results.find((message: any) => message.toolName === "write")?.isError ? "denied" : profile.write ? "ok" : "unused"}`);
}));

function addProfile(name: string, tools = ["read"], write = false) {
  const cwd = join(directory, name);
  mkdirSync(cwd);
  writeFileSync(join(cwd, "input.txt"), `private-${name}`);
  const profile = { name, cwd, tools, write, reached: deferred(), gate: deferred(), hold: true };
  profiles.set(name, profile);
  return profile;
}

async function openChild(name: string, fresh: boolean) {
  const profile = profiles.get(name);
  assert(profile, "Profile must be declared by the test");
  const state: any = { name, closing: false, release: undefined, run: undefined, storage: undefined };
  const storage = await openNodeSqliteStorage(join(profile.cwd, "session.sqlite"));
  state.storage = storage;
  const originalCommit = storage.commit.bind(storage);
  storage.commit = async (writes: any, ctx: any) => {
    if (state.injectAckFailure) { state.injectAckFailure = false; throw new Error("Injected ACK storage failure"); }
    return originalCommit(writes, ctx);
  };
  const env = new NodeExecutionEnv({ cwd: profile.cwd });
  const rawTools: any[] = [createReadTool(), createWriteTool()];
  const permitted = (name: string) => state.binding.tools.includes(name);
  const tools = rawTools.map(tool => ({ ...tool, replay: tool.name === "read" ? "safe" : "unsafe",
    execute: async (args: any, toolApi: any, ctx: any) => {
      assert(state.release, "Tool effect requires an active quota reservation");
      if (!permitted(tool.name)) throw new Error(`Tool denied by accepted policy: ${tool.name}`);
      assert.equal((await toolApi.agent(ctx)).cwd, state.binding.cwd);
      log("tool-enter", { name, tool: tool.name, cwd: state.binding.cwd });
      if (tool.name === "read" && profile.hold) {
        profile.reached.resolve();
        const abort = deferred();
        const onAbort = () => abort.reject(ctx.abortSignal.reason);
        ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
        try {
          ctx.abortSignal.throwIfAborted();
          await Promise.race([profile.gate.promise, abort.promise]);
        } finally { ctx.abortSignal.removeEventListener("abort", onAbort); }
      }
      const result = await tool.execute(args, toolApi, ctx);
      log("tool-effect", { name, tool: tool.name, cwd: state.binding.cwd, content: result.content });
      return result;
    },
  }));
  const extension = defineExtension({ name: "spike-tools", tools, tasks: [Anchor], hooks: [hook(ToolTask, {
    beforeTool(call: any) { if (!permitted(call.name)) { log("policy-block", { name, tool: call.name }); return { block: `Tool denied by accepted policy: ${call.name}` }; } },
  })] });
  const registry = createRegistry(); registry.install(extension);
  const models = new Proxy(runtime, { get(target, key) {
    if (key === "streamSimple") return (...args: any[]) => {
      assert(state.release, "Model effect requires an active quota reservation");
      assert.equal(args[0].provider, identity.provider);
      assert.equal(args[0].id, identity.id);
      return target.streamSimple(...args);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  state.harness = await Harness.open(storage, { models, registry, env: () => env,
    settings: { retry: { enabled: false }, compaction: { enabled: false } }, onReport: (error: any) => errors.push(error) }, context);
  state.root = await state.harness.root(context);
  if (fresh) {
    await state.root.commit(async (tx: any) => {
      const owner = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true });
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
      await configure(tx, child.id, { model: { provider: identity.provider, modelId: identity.id }, tools: tools.filter(t => profile.tools.includes(t.name)),
        extensions: [extension], cwd: profile.cwd, instructions: "Follow the explicit task tool plan. Do not discover files or use additional tools." });
      Object.assign(await tx.doc(Binding), { name, childId: child.id, ownerId: owner, cwd: profile.cwd, tools: profile.tools,
        parent: { sessionId: parentContext.sessionManager.getSessionId(), entryId: parentContext.sessionManager.getLeafId() },
        control: "autonomous", requestId: `request:${name}`, text: "", receipt: null, selected: null });
    }, context);
  }
  state.binding = await state.harness.snapshot(Binding, context);
  assert.equal(state.binding.name, name, "Persisted task identity must match");
  assert.equal(state.binding.parent.sessionId, parentContext.sessionManager.getSessionId(), "Parent session must match");
  assert.equal(state.binding.cwd, profile.cwd);
  assert(Array.isArray(state.binding.tools) && state.binding.tools.every((name: any) => ["read", "write"].includes(name)));
  state.child = await state.harness.conversation(state.binding.childId, context);
  state.env = env;
  state.refresh = async () => { state.binding = await state.harness.snapshot(Binding, context); return state.binding; };
  children.set(name, state); allChildren.push(state);
  log("opened", { name, fresh });
  return state;
}

async function start(state: any) {
  if (state.run) return true;
  const release = quota.tryAcquire(identity);
  if (!release) { log("quota-blocked", { name: state.name }); return false; }
  state.release = release;
  log("quota-acquired", { name: state.name });
  state.run = (async () => {
    try {
      const plan = `TASK ${state.name}. Call read(path="input.txt") to read this task's fixture. ${profiles.get(state.name).write ? 'Then call write(path="output.txt", content=the exact read result) to verify write authorization.' : 'Do not call any other tool.'} Return the read result and write outcome. Do not explore.`;
      const submission = await state.child.submit({ type: "input", content: plan, requestId: state.binding.requestId }, context);
      log("submitted", { name: state.name, submissionId: submission.id });
      const settled = await submission.wait(context);
      assert.equal(settled.status, "done"); assert.equal(settled.type, "input");
      const entry = await state.child.commit((tx: any) => tx.entry(AssistantEntry, settled.answer), context);
      const result = text(entry.model[0]);
      await state.root.commit(async (tx: any) => { const binding = await tx.doc(Binding); binding.text = result; binding.answerId = settled.answer; }, context);
      await state.refresh();
      log("settled", { name: state.name, answerId: settled.answer, text: result });
    } catch (error) {
      if (!state.closing) throw error;
      log("closed-inflight", { name: state.name });
    } finally {
      state.release = undefined; release(); log("quota-released", { name: state.name });
    }
  })();
  // Keep background failures observable without unhandled rejection noise.
  state.run.catch((error: any) => { state.error = error; });
  return true;
}

async function closeChild(state: any) {
  if (state.closed) return;
  state.closing = true;
  await state.harness.close(context);
  await state.run;
  await state.env.cleanup(context);
  state.closed = true;
}

async function flush(state: any, selection = false) {
  const binding = await state.refresh();
  if (!binding.text || (!selection && binding.control !== "autonomous")) return "ineligible";
  const receiptKey = selection ? "selected" : "receipt";
  if (binding[receiptKey]) return "received";
  const delivery = { deliveryId: `${selection ? "selection" : "automatic"}:${state.name}`, taskId: state.name,
    operationId: binding.requestId, parent: binding.parent, kind: selection ? "selection" : "automatic", status: "completed",
    text: binding.text, sourceEntryIds: [String(binding.answerId)], createdAt: 1 };
  const attempt = await channel.deliver(delivery, () => !state.closed && (selection || state.binding.control === "autonomous"));
  if (attempt.status === "received") {
    state.injectAckFailure = failAck; failAck = false;
    await state.root.commit(async (tx: any) => { (await tx.doc(Binding))[receiptKey] = attempt.receipt; }, context);
    await state.refresh();
  }
  log("delivery", { name: state.name, status: attempt.status });
  return attempt.status;
}

async function createParent(manager?: any) {
  settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [parentFactory] });
  await loader.reload();
  const opened = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, model: parentProvider.getModel(),
    sessionManager: manager ?? SessionManager.create(directory, directory), settingsManager: settings, resourceLoader: loader, tools: ["Agent"] });
  parent = opened.session;
  await parent.bindExtensions({ onError: (error: any) => errors.push(error) });
  channel = new PiDeliveryChannel(api, () => parentContext);
}

async function command(name: string, action = "spawn") {
  parentProvider.setResponses([fauxAssistantMessage(fauxToolCall("Agent", { name, action }), { stopReason: "toolUse" }), fauxAssistantMessage(`Accepted ${action} ${name}`)]);
  await parent.prompt(`Use Agent action=${action}, name=${name}. Execute only this explicit request.`);
  const result = parent.sessionManager.getEntries().findLast((entry: any) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "Agent");
  assert(result && !result.message.isError, text(result?.message));
  return result.message;
}
function receipts(name: string) {
  return parseSessionEntries(readFileSync(parent.sessionManager.getSessionFile(), "utf8")).filter((entry: any) => entry.type === "custom_message" && entry.details?.taskId === name && entry.customType === "subagents-lite:v3-result");
}
async function deliver(state: any, selection = false) {
  parentProvider.setResponses([fauxAssistantMessage("Received the durable child report.")]);
  const result = await flush(state, selection);
  await parent.waitForIdle();
  return result;
}

try {
  runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(parentProvider.provider); runtime.registerNativeProvider(workerProvider.provider);
  parentFactory = (pi: any) => {
    api = pi;
    pi.on("session_start", (_event: any, ctx: any) => { parentContext = ctx; });
    pi.registerTool({ name: "Agent", label: "Agent", description: "Run the specified durable boundary task or explicitly take control.",
      parameters: Type.Object({ name: Type.String(), action: Type.Union([Type.Literal("spawn"), Type.Literal("takeover"), Type.Literal("resume")]) }),
      execute: async (_id: any, args: any) => {
        let state = children.get(args.name);
        if (args.action === "spawn") { assert(!state); state = await openChild(args.name, true); await start(state); }
        else {
          assert(state && state.binding.parent.sessionId === parentContext.sessionManager.getSessionId(), "Task does not belong to this parent");
          if (args.action === "takeover") {
            await state.root.commit(async (tx: any) => { (await tx.doc(Binding)).control = "manual"; }, context);
            await state.refresh();
          } else await start(state);
        }
        return { content: [{ type: "text", text: `${args.action}: ${args.name}` }], details: { taskId: args.name } };
      },
    });
  };
  await createParent();
  parentProvider.setResponses([fauxAssistantMessage("Parent ready.")]); await parent.prompt("Initialize isolated boundary validation.");

  const a = addProfile("reader", ["read"], true);
  const b = addProfile("writer", ["read", "write"], true);
  await command(a.name); const sa = children.get(a.name); await a.reached.promise;
  await command(b.name); const sb = children.get(b.name); await b.reached.promise;
  assert(parent.isStreaming === false); assert(sa.release && sb.release);
  assert.equal(quota.tryAcquire(identity), undefined, "Two active children consume both slots");
  await sa.root.abort(context); await sa.root.waitForIdle(context);
  assert(sa.release, "Root abort and idle must not reach a background-owned child");
  pass("official Pi Agent dispatch returns while background tools remain active");
  a.gate.resolve(); b.gate.resolve();
  await Promise.all([sa.run, sb.run]);
  assert.match(sa.binding.text, /private-reader/); assert.match(sa.binding.text, /write=denied/);
  assert.match(sb.binding.text, /private-writer/);
  assert(!existsSync(join(a.cwd, "output.txt"))); assert.equal(readFileSync(join(b.cwd, "output.txt"), "utf8"), "private-writer");
  assert(!events.some(event => event.event === "tool-effect" && event.name === "reader" && event.tool === "write"));
  await deliver(sa); await deliver(sb); assert.equal(receipts(a.name).length, 1); assert.equal(receipts(b.name).length, 1);
  pass("concurrent cwd and accepted tool sets stay isolated; forged write is rejected");
  await closeChild(sa); await closeChild(sb);

  const p = addProfile("policy-gate", ["read"], true);
  await command(p.name); const sp = children.get(p.name); await p.reached.promise;
  await sp.child.configure({ tools: [createReadTool(), createWriteTool()] }, context);
  assert.deepEqual((await sp.child.agent(context)).tools.map((tool: any) => tool.name), ["read", "write"]);
  p.gate.resolve(); await sp.run;
  assert.match(sp.binding.text, /write=denied/);
  assert(events.some(event => event.event === "policy-block" && event.name === p.name && event.tool === "write"));
  assert(!existsSync(join(p.cwd, "output.txt")));
  pass("execution policy rejects write even after the live declaration is expanded");
  await closeChild(sp);

  const m = addProfile("manual"); await command(m.name); let sm = children.get(m.name); await m.reached.promise;
  await command(m.name, "takeover"); assert(sm.release, "Takeover retains the executing reservation");
  m.gate.resolve(); await sm.run; assert.equal(await deliver(sm), "ineligible"); assert.equal(receipts(m.name).length, 0);
  await closeChild(sm); sm = await openChild(m.name, false);
  assert.equal(sm.binding.control, "manual"); assert.equal(await deliver(sm), "ineligible");
  await deliver(sm, true); assert.equal(receipts(m.name).length, 1);
  pass("takeover survives reopen and only explicit selection delivers output"); await closeChild(sm);

  const f = addProfile("parent-failure"); f.hold = false;
  await command(f.name); let sf = children.get(f.name); await sf.run;
  const manager = parent.sessionManager; const persist = manager._persist;
  manager._persist = function(entry: any) { if (entry.type === "custom_message" && entry.details?.taskId === f.name) return; return persist.call(this, entry); };
  await assert.rejects(deliver(sf), /not durably persisted/);
  manager._persist = persist;
  assert.equal(receipts(f.name).length, 0); assert.equal((await sf.refresh()).receipt, null);
  await assert.rejects(deliver(sf), /only in memory/);
  const parentFile = parent.sessionManager.getSessionFile(); await parent.abort(); parent.dispose(); await settings.flush();
  await closeChild(sf); await createParent(SessionManager.open(parentFile)); sf = await openChild(f.name, false);
  await deliver(sf); await deliver(sf); assert.equal(receipts(f.name).length, 1);
  pass("failed parent append survives both sides reopening without duplicate delivery"); await closeChild(sf);

  const k = addProfile("ack-failure"); k.hold = false; await command(k.name); let sk = children.get(k.name); await sk.run;
  failAck = true; await assert.rejects(deliver(sk), /Injected ACK storage failure/); await parent.waitForIdle();
  assert.equal(receipts(k.name).length, 1);
  await closeChild(sk); sk = await openChild(k.name, false);
  assert.equal(sk.binding.receipt, null); const parentCalls = parentProvider.state.callCount;
  await deliver(sk); await deliver(sk); assert.equal(receipts(k.name).length, 1); assert(sk.binding.receipt);
  assert.equal(parentProvider.state.callCount, parentCalls, "Receipt recovery must not wake the parent twice");
  pass("ACK commit failure reuses the durable parent receipt after reopen"); await closeChild(sk);

  quota.setLimits({ default: 1, providers: { child: 1 } });
  const r = addProfile("recovery"); await command(r.name); let sr = children.get(r.name); await r.reached.promise;
  const q = addProfile("queued"); q.hold = false; await command(q.name); let sq = children.get(q.name);
  assert(!sq.run, "Queued child must not submit without quota");
  assert.equal(await sq.storage.submissionByRequest(sq.binding.childId, sq.binding.requestId, context), undefined);
  await closeChild(sr); await closeChild(sq);
  const block = quota.tryAcquire(identity); assert(block, "Close releases the actual execution reservation");
  r.hold = false;
  r.tools = ["write"]; // Changed source configuration must not replace the accepted policy on reopen.
  const before = workerProvider.state.callCount; const effects = events.filter(event => event.event === "tool-effect").length;
  sr = await openChild(r.name, false); sq = await openChild(q.name, false);
  assert.deepEqual(sr.binding.tools, ["read"]);
  assert.equal(await start(sr), false); assert.equal(await start(sq), false);
  assert.equal(workerProvider.state.callCount, before); assert.equal(events.filter(event => event.event === "tool-effect").length, effects);
  block(); await command(r.name, "resume"); await sr.run; await deliver(sr);
  await command(q.name, "resume"); await sq.run; await deliver(sq);
  assert.equal(receipts(r.name).length, 1); assert.equal(receipts(q.name).length, 1);
  const first = await sr.storage.submissionByRequest(sr.binding.childId, sr.binding.requestId, context);
  const repeat = await sr.child.submit({ type: "input", content: "Duplicate request must not execute", requestId: sr.binding.requestId }, context);
  assert.equal(repeat.id, first.id); const settled = await repeat.status(context); assert.equal(settled.status, "done");
  assert.equal(events.filter(event => event.event === "tool-effect" && event.name === r.name && event.tool === "read").length, 1);
  pass("interrupted safe tool resumes once; unopened work and recovery require fresh quota admission");
  await closeChild(sr); await closeChild(sq);
  assert.deepEqual(errors, []);
} finally {
  const cleanup = await Promise.allSettled(allChildren.map(closeChild));
  for (const result of cleanup) if (result.status === "rejected") errors.push(String(result.reason));
  if (parent) { await parent.abort(); parent.dispose(); }
  if (settings) await settings.flush();
  writeFileSync(join(directory, "evidence.json"), JSON.stringify({ checks, errors: errors.map(String), versions, events }, null, 2));
  console.log(`Evidence: ${directory}`);
  assert.deepEqual(errors, [], "All execution and cleanup errors must be accounted for");
}
