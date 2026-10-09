import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import { Harness, createRegistry, defineExtension, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import { LiveDoc, type Conversation, type ConversationView, type LiveState, type UsageState, type Storage, type ToolRegistration, type HarnessSettings, type EntryRecord } from "@earendil-works/pi-durable";
import { createReadTool, createWriteTool, createEditTool, createBashTool } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { DriveResult, ExecutionDriver, ExecutionMessage, ExecutionResult, ExecutionSnapshot, TaskBinding, TaskInput } from "../engine/contracts.js";
import { NativeTaskStore, TaskDocument, type Operation } from "./native-task-store.js";
import { projectMessage } from "./message-projection.js";
import { extractText } from "../prompt/context.js";
import type { PiResources } from "./pi-resources.js";
import { withStreamWatchdog } from "./stream-watchdog.js";

const context = BACKGROUND_CONTEXT;
const content = (input: TaskInput) => input.images?.length ? [{ type: "text" as const, text: input.text }, ...input.images] : input.text;
export interface DurableDriverOptions {
  path?: string;
  storage?: Storage;
  binding?: TaskBinding;
  models: Models;
  tools?: ToolRegistration[];
  retry?: HarnessSettings["retry"];
  compaction?: HarnessSettings["compaction"];
  piResources?: PiResources;
}

/** Each accepted task owns its scheduler; only drive enables model and tool effects. */
export class DurableDriver implements ExecutionDriver {
  store!: NativeTaskStore;
  harness!: Harness;
  conversation!: Conversation;
  private readonly registry = createRegistry();
  private env?: NodeExecutionEnv;
  private driving?: Promise<DriveResult>;
  private closing?: Promise<void>;
  private queueWork: Promise<void> = Promise.resolve();
  private readonly subscriptions = new Set<() => void>();
  private readonly messageCache = new Map<string, ExecutionMessage>();
  private requestError?: string;
  private partial?: AssistantMessage;
  private abortWork?: Promise<void>;
  private readonly lifetime = new AbortController();
  private constructor(private readonly options: DurableDriverOptions) {}

  static async open(options: DurableDriverOptions): Promise<DurableDriver> {
    const driver = new DurableDriver(options);
    try {
      const storage = options.storage ?? await openNodeSqliteStorage(options.path!);
      const models = new Proxy(options.models, { get(target, key) {
        if (key === "streamSimple") return driver.stream.bind(driver);
        if (key === "completeSimple") return (...args: Parameters<Models["streamSimple"]>) => driver.stream(...args).result();
        if (key === "streamDeferred") return (...args: Parameters<Models["streamDeferred"]>) => {
          driver.assertDriving();
          const accepted = driver.store.binding.policy.model;
          if (args[0].provider !== accepted.provider || args[0].id !== accepted.id) throw new Error("Model exceeds accepted policy");
          return withStreamWatchdog(args[0], args[2]?.signal, signal => target.streamDeferred(args[0], args[1], { ...args[2], signal }));
        };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      driver.harness = await Harness.open(storage, { models, registry: driver.registry,
        settings: { retry: options.retry, compaction: options.compaction }, env: () => driver.env }, context);
      driver.store = await NativeTaskStore.open(driver.harness, options.binding, options.path);
      const policy = driver.store.binding.policy;
      if (!options.models.getModel(policy.model.provider, policy.model.id)) throw new Error("Accepted model is unavailable");
      driver.env = new NodeExecutionEnv({ cwd: policy.cwd });
      driver.conversation = await driver.harness.root(context, { agent: { model: { provider: policy.model.provider, modelId: policy.model.id },
        thinkingLevel: policy.thinkingLevel, cwd: policy.cwd } });
      const configured = await driver.conversation.agent(context);
      if (configured.model?.provider !== policy.model.provider || configured.model.modelId !== policy.model.id
        || configured.thinkingLevel !== policy.thinkingLevel || configured.cwd !== policy.cwd) {
        throw new Error("Durable configuration differs from its accepted policy");
      }
      driver.installTools(options.tools ?? options.piResources?.tools ?? [createReadTool(), createWriteTool(), createEditTool(), createBashTool()]);
      if (options.binding) await driver.conversation.configure({ tools: (options.piResources?.activeTools ?? policy.tools)
        .map(name => driver.registry.snapshot().tools().find(tool => tool.tool.name === name)?.tool).filter((tool): tool is ToolRegistration => !!tool) }, context);
      await options.piResources?.attach(driver);
      // Reconstruct a result that committed natively before the host saved its projection.
      const operation = await driver.store.currentOperation();
      if (operation && !operation.result) {
        const submission = await driver.submission(operation.id);
        if (submission?.status === "done" || submission?.status === "unanswered") await driver.finish(operation);
      }
      return driver;
    } catch (error) {
      try { await driver.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Durable task attachment failed", { cause: cleanup }); }
      throw error;
    }
  }

  installTools(tools: readonly ToolRegistration[]): void {
    const secured = tools.map(tool => ({ ...tool, execute: ((...args: Parameters<typeof tool.execute>) => {
      this.assertDriving();
      if (!this.options.piResources && !this.store.binding.policy.tools.includes(tool.name)) throw new Error(`Tool exceeds accepted policy: ${tool.name}`);
      return tool.execute(...args);
    }) }));
    this.registry.install(defineExtension({ name: "subagents-lite", tools: secured, sections: [section("subagents_instructions", () => this.options.piResources?.systemPrompt ?? this.store.binding.policy.systemPrompt, { tag: false })], hooks: [hook(GenerationTask, {
      beforeRequest: async (request, _api, callContext) => {
        const messages = await this.options.piResources?.prepareContext([...request.messages], callContext.abortSignal);
        return messages ? { messages } : undefined;
      },
    })] }));
  }
  async setActiveTools(names: readonly string[]): Promise<void> {
    const tools = this.registry.snapshot().tools().filter(item => names.includes(item.tool.name)).map(item => item.tool);
    await this.conversation.configure({ tools }, context);
  }
  async view(): Promise<ConversationView> {
    const watch = await this.conversation.watch(context);
    try { return watch.value; } finally { await watch.stop(); }
  }
  async accept(input: TaskInput, requestId?: string): Promise<string> {
    this.assertOpen();
    const entries = (await this.view()).entries;
    return this.store.accept(input, entries.at(-1)?.id ?? null, requestId);
  }
  drive(operationId: string): Promise<DriveResult> {
    this.assertOpen();
    if (this.driving) return this.driving;
    this.driving = Promise.resolve().then(async (): Promise<DriveResult> => {
      const operation = (await this.store.operations())[operationId];
      if (!operation) throw new Error("Unknown task operation");
      if (operation.result) return { kind: "settled", result: operation.result };
      if (operation.cancelled) {
        if (await this.submission(operationId)) await this.conversation.abort(context);
        return { kind: "settled", result: await this.finish(operation) };
      }
      this.requestError = undefined; this.partial = undefined;
      await this.options.piResources?.beforeRun(operation.input);
      // Inputs accepted before execution join the first request, without starting extra turns.
      const pending = await this.store.pending();
      const admitted = await this.submission(operationId);
      let input = operation.input;
      if (!admitted && pending.length) {
        input = { text: [operation.input.text, ...pending.map(item => item.input.text)].join("\n\n"),
          images: [...(operation.input.images ?? []), ...pending.flatMap(item => item.input.images ?? [])] };
        for (const item of pending) {
          await this.conversation.submit({ type: "write", requestId: item.id, entry: { kind: "subagents-lite.input", data: { operationId } } }, context);
        }
      }
      const submission = await this.conversation.submit({ type: "input", content: content(input), requestId: operationId }, context);
      if (!admitted) for (const item of pending) await this.store.removePending(item.id);
      await this.flushQueue();
      await submission.wait(context);
      await this.queueWork; await this.abortWork;
      await this.conversation.waitForIdle(context);
      await this.options.piResources?.flush(); this.assertOpen();
      return { kind: "settled", result: await this.finish(operation) };
    }).finally(() => { this.driving = undefined; });
    return this.driving;
  }
  async requestAbort(operationId: string, stoppedBy?: "user" | "agent"): Promise<void> {
    this.assertOpen(); await this.store.recordStop(operationId, stoppedBy);
    if (this.driving) {
      if (this.partial) await this.harness.commit(async tx => {
        const live = await tx.doc(LiveDoc, this.conversation.id);
        if (live.generation) live.generation.message = JSON.parse(JSON.stringify(this.partial));
      }, context);
      this.abortWork = this.conversation.abort(context);
      this.abortWork.catch(() => {}); // drive observes cancellation settlement and propagates storage failures.
      await this.harness.commit(() => undefined, context);
    }
  }
  async queue(kind: "steer" | "followUp", input: TaskInput, requestId?: string): Promise<string> {
    this.assertOpen(); const id = await this.store.enqueue(kind, input, requestId);
    if (this.driving) await this.flushQueue();
    return id;
  }
  private flushQueue(): Promise<void> {
    this.queueWork = this.queueWork.then(async () => {
      for (const item of await this.store.pending()) {
        if (await this.submission(item.id)) { await this.store.removePending(item.id); continue; }
        await this.conversation.submit({ type: "input", content: content(item.input), requestId: item.id, whenBusy: item.kind }, context);
        await this.store.removePending(item.id);
      }
    });
    return this.queueWork;
  }
  async cancelQueued(id: string): Promise<"cancelled" | "already_consumed" | "not_found"> {
    if (await this.store.removePending(id)) return "cancelled";
    const record = await this.submission(id);
    if (!record) return "not_found";
    const handle = await this.harness.submission(record.id, context);
    return await handle!.abort(context) === "aborted" ? "cancelled" : "already_consumed";
  }
  private async submission(id: string) {
    return this.harness.commit(tx => tx.submissionByRequest(this.conversation.id, id), context);
  }
  private operationEntries(entries: readonly EntryRecord[], operation?: Operation) {
    return entries.filter(entry => operation?.fromEntryId == null || entry.id > operation.fromEntryId);
  }
  private async finish(original: Operation): Promise<ExecutionResult> {
    return this.store.result(original.id, this.conversation.id, this.requestError);
  }
  private turns(entries: readonly EntryRecord[]): number {
    return entries.filter(entry => entry.model?.some(message => message.role === "assistant" && !["error", "aborted", "pending", "deferred"].includes(message.stopReason))).length;
  }
  async snapshot(): Promise<ExecutionSnapshot> {
    this.assertOpen();
    const view = await this.view(); const operation = await this.store.currentOperation();
    const live = view.docs["pi.live"] as LiveState | undefined;
    const messages = view.entries.flatMap(entry => (entry.model ?? []).map((message, index) => {
      const key = `${entry.id}:${index}`;
      let projected = this.messageCache.get(key);
      if (!projected) { projected = projectMessage(String(entry.id), message); this.messageCache.set(key, projected); }
      return projected;
    }));
    const assistants = view.entries.flatMap(entry => entry.model ?? []).filter((message): message is AssistantMessage => message.role === "assistant");
    const usage = view.docs["pi.usage"] as UsageState | undefined;
    const usages = [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})];
    const sum = (key: "input" | "output") => usages.reduce((total, item) => total + item[key], 0);
    const last = assistants.at(-1); const model = this.options.models.getModel(this.store.binding.policy.model.provider, this.store.binding.policy.model.id);
    const pending = (await this.store.pending()).map(item => ({ entryId: item.id, kind: item.kind, text: item.input.text, images: item.input.images }));
    const inbox = view.docs["pi.inbox"] as { items?: { id: number; mode: "steer" | "followUp" | "write"; content?: unknown }[] } | undefined;
    const queued: ExecutionSnapshot["queued"][number][] = [];
    for (const item of inbox?.items ?? []) {
      const handle = await this.harness.submission(item.id as never, context);
      const record = await handle?.status(context);
      queued.push({ entryId: record?.requestId ?? String(item.id), kind: item.mode as "steer" | "followUp", text: typeof item.content === "string" ? item.content : "", images: undefined });
    }
    queued.push(...pending);
    return { operation: operation && !operation.result ? { operationId: operation.id, cancelling: !!operation.cancelled, startedAt: operation.startedAt } : undefined,
      lastResult: operation?.result, messages, streaming: live?.generation?.message ? projectMessage("streaming", live.generation.message) : undefined,
      stats: { input: sum("input"), output: sum("output"), cost: usages.reduce((total, item) => total + item.cost.total, 0),
        toolUses: messages.filter(message => message.role === "toolResult").length, turnCount: this.turns(this.operationEntries(view.entries, operation)),
        compactions: view.entries.filter(entry => entry.kind === "pi.compaction").length,
        contextPercent: last && model?.contextWindow ? (last.usage.input + last.usage.cacheRead + last.usage.cacheWrite + last.usage.output) / model.contextWindow * 100 : null },
      retry: live?.generation?.retry ? { attempt: live.generation.attempt + 1, maxAttempts: (this.options.retry?.maxRetries ?? 3) + 1, nextAttemptAt: live.generation.retry.at } : undefined,
      queued, faulted: false };
  }
  async observe(listener: () => void): Promise<() => void> {
    const watch = await this.conversation.watch(context);
    const documents = await this.harness.watchDoc(TaskDocument, context);
    const stop = () => { void watch.stop(); void documents?.stop(); this.subscriptions.delete(stop); };
    this.subscriptions.add(stop);
    watch.start(async () => { if (!this.closing) listener(); });
    documents?.start(async () => { if (!this.closing) listener(); });
    return stop;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      for (const stop of this.subscriptions) stop();
      this.lifetime.abort(new Error("Execution driver is closing"));
      const cleanup = await Promise.allSettled([this.options.piResources?.close()]);
      cleanup.push(...await Promise.allSettled([this.harness?.close(context)]));
      await Promise.allSettled([this.driving, this.queueWork]);
      cleanup.push(...await Promise.allSettled([this.env?.cleanup(context)]));
      const errors = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      this.messageCache.clear();
      if (errors.length) throw new AggregateError(errors, "Durable task cleanup failed");
    });
    return this.closing;
  }
  private stream(...[model, request, options]: Parameters<Models["streamSimple"]>) {
    const output = createAssistantMessageEventStream();
    void (async () => {
      this.assertDriving();
      const policy = this.store.binding.policy;
      if (model.provider !== policy.model.provider || model.id !== policy.model.id) throw new Error("Model exceeds accepted policy");
      const op = await this.store.currentOperation();
      const turns = this.turns(this.operationEntries((await this.view()).entries, op));
      const max = policy.limits.maxTurns;
      if (max !== undefined && turns >= max + Math.max(1, policy.limits.graceTurns)) throw new Error("Subagent turn limit reached");
      const prepared = await this.options.piResources?.prepareStream(options);
      const projected = this.options.piResources?.projectRequest(request) ?? request;
      if (max !== undefined && turns >= max) projected.messages = [...projected.messages, { role: "user", content: `You have reached your turn limit of ${max}. Stop calling tools and write your final answer, including any unfinished work.`, timestamp: Date.now() }];
      const source = withStreamWatchdog(model, options?.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal, signal => this.options.models.streamSimple(model, projected,
        { ...options, ...prepared, signal, ...(policy.limits.maxTokens ? { maxTokens: policy.limits.maxTokens } : {}) }));
      for await (const event of source) {
        if ("partial" in event) this.partial = structuredClone(event.partial);
        if (event.type === "done" || event.type === "error") {
          let message = event.type === "done" ? event.message : event.error;
          message = await this.options.piResources?.afterResponse(message) ?? message;
          const value = extractText(message.content).trim();
          if (message.stopReason === "stop" && (!value || /^call:[^\s{}]+\s*\{[\s\S]*\}\s*$/.test(value))) {
            this.requestError = value ? `Subagent emitted unexecuted tool call text: ${value}` : "Subagent completed without final assistant text";
            message = { ...message, stopReason: "error", errorMessage: this.requestError };
          }
          if (message.stopReason === "error" || message.stopReason === "aborted") output.push({ type: "error", reason: message.stopReason, error: message });
          else output.push({ type: "done", reason: message.stopReason as "stop", message });
          output.end(message);
        } else output.push(event);
      }
    })().catch(error => {
      this.requestError = String(error);
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [],
        timestamp: Date.now(), stopReason: "error", errorMessage: String(error), usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } };
      output.push({ type: "error", reason: "error", error: message }); output.end(message);
    });
    return output;
  }
  private assertOpen() { if (this.closing) throw new Error("Execution driver is closed"); }
  private assertDriving() { this.assertOpen(); if (!this.driving) throw new Error("Task effects require execution admission"); }
}
