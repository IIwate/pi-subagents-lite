import {
  AgentHarness, BACKGROUND_CONTEXT, createBashTool, createEditTool, createReadTool, createWriteTool,
  getOrThrow, type AgentHarnessOptions, type AgentLane, type AgentMessage, type Entry,
  type ExecutionToolContext, type LaneSnapshot, type OperationResultRecord, type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Models } from "@earendil-works/pi-ai";
import type { TaskOutcome } from "../domain/task.js";
import type {
  DriveResult, ExecutionDriver, ExecutionMessage, ExecutionResult, ExecutionSnapshot, TaskBinding, TaskInput,
} from "../engine/contracts.js";
import { extractText } from "../prompt/context.js";
import { NativeTaskStore } from "./native-task-store.js";

const context = BACKGROUND_CONTEXT;

export interface HarnessDriverOptions {
  /** Ownership transfers to the driver, including cleanup after failed attachment. */
  session: Session;
  models: Models;
  binding?: TaskBinding;
  tools?: AgentHarnessOptions<ExecutionToolContext>["tools"];
  resources?: AgentHarnessOptions<ExecutionToolContext>["resources"];
  retry?: AgentHarnessOptions<ExecutionToolContext>["retry"];
  compaction?: AgentHarnessOptions<ExecutionToolContext>["compaction"];
}

function textOf(message: AgentMessage): string {
  if (!("content" in message)) return "";
  return typeof message.content === "string" ? message.content : Array.isArray(message.content) ? extractText(message.content) : "";
}

function messages(entries: readonly Entry[]): ExecutionMessage[] {
  return entries.flatMap(entry => entry.type === "message"
    ? [Object.freeze({ entryId: entry.id, role: entry.message.role, text: textOf(entry.message) })] : []);
}

function turns(entries: readonly Entry[]): number {
  return entries.filter(entry => entry.type === "message" && entry.message.role === "assistant"
    && entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted"
    && entry.message.stopReason !== "pending" && entry.message.stopReason !== "deferred").length;
}

function operationEntries(snapshot: LaneSnapshot): Entry[] {
  const origin = snapshot.operation?.fromTipId ?? snapshot.lastResult?.fromTipId;
  const start = origin == null ? 0 : snapshot.transcript.findIndex(entry => entry.id === origin) + 1;
  return snapshot.transcript.slice(start);
}

/** One task owns its Harness so tool implementations, resources and cwd cannot leak between agents. */
export class HarnessDriver implements ExecutionDriver {
  private readonly subscriptions = new Set<() => void>();
  private readonly drives = new Map<string, Promise<DriveResult>>();
  private closing?: Promise<void>;
  private policyWork: Promise<void> = Promise.resolve();
  private policyError?: unknown;
  private turnCount = 0;
  private currentOperationId?: string;
  private warned = false;

  private constructor(
    readonly store: NativeTaskStore,
    private readonly harness: AgentHarness<ExecutionToolContext>,
    private readonly lane: AgentLane,
    private readonly env: NodeExecutionEnv,
  ) {}

  static async open(options: HarnessDriverOptions): Promise<HarnessDriver> {
    let harness: AgentHarness<ExecutionToolContext> | undefined;
    let env: NodeExecutionEnv | undefined;
    try {
      const store = await NativeTaskStore.open(options.session, options.binding);
      const policy = store.binding.policy;
      const sourceModel = options.models.getModel(policy.model.provider, policy.model.id);
      if (!sourceModel) throw new Error(`Accepted model is unavailable: ${policy.model.provider}/${policy.model.id}`);
      const model = { ...sourceModel, ...(policy.limits.maxTokens === undefined ? {} : { maxTokens: policy.limits.maxTokens }) };
      // The native engine resolves models again per request. Scope lookup and output limits without mutating the host catalogue.
      const getModel: Models["getModel"] = (provider, id) => provider === model.provider && id === model.id ? model : undefined;
      const streamSimple: Models["streamSimple"] = (requestModel, request, streamOptions) => options.models.streamSimple(requestModel, request, {
        ...streamOptions, ...(policy.limits.maxTokens === undefined ? {} : { maxTokens: policy.limits.maxTokens }),
      });
      const models = new Proxy(options.models, {
        get(target, key) {
          if (key === "getModel") return getModel;
          if (key === "streamSimple") return streamSimple;
          const member: unknown = Reflect.get(target, key, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
      env = new NodeExecutionEnv({ cwd: policy.cwd });
      const tools = options.tools ?? [createReadTool(), createBashTool(), createEditTool(), createWriteTool()];
      const available = new Set(tools.map(tool => tool.name));
      for (const name of policy.tools) {
        if (!available.has(name)) throw new Error(`Accepted tool is unavailable: ${name}`);
      }
      const attached = await AgentHarness.create<ExecutionToolContext>({
        session: options.session, models, model, tools: [...tools], toolContext: { env },
        systemPrompt: policy.systemPrompt, activeToolNames: [...policy.tools], thinkingLevel: policy.thinkingLevel,
        resources: options.resources, retry: options.retry, compaction: options.compaction,
      }, context);
      harness = attached.harness;
      const lane = await harness.lane(store.binding.taskId, context);
      const configured = await lane.getModel(context);
      if (configured?.provider !== policy.model.provider || configured.id !== policy.model.id
        || await lane.getThinkingLevel(context) !== policy.thinkingLevel
        || JSON.stringify(await lane.getActiveTools(context)) !== JSON.stringify(policy.tools)) {
        throw new Error("Native lane configuration differs from its accepted policy");
      }
      const driver = new HarnessDriver(store, harness, lane, env);
      const watch = await lane.watch(context);
      const snapshot = watch.snapshot;
      watch.unsubscribe();
      driver.currentOperationId = snapshot.operation?.id;
      driver.turnCount = snapshot.operation ? turns(operationEntries(snapshot)) : 0;
      driver.warned = operationEntries(snapshot).some(entry => entry.type === "message" && textOf(entry.message) === driver.limitReminder())
        || snapshot.queues.some(item => item.type === "message" && textOf(item.message) === driver.limitReminder());
      driver.installPolicy();
      return driver;
    } catch (error) {
      const cleanup = await Promise.allSettled([
        harness ? harness.close(context) : options.session.close(context),
        ...(env ? [env.cleanup(context)] : []),
      ]);
      const failures = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError([error, ...failures], "Native task attachment and cleanup failed");
      throw error;
    }
  }

  async accept(input: TaskInput): Promise<string> {
    this.assertOpen();
    const admission = getOrThrow(await this.lane.accept({ kind: "prompt", prompt: input.text,
      ...(input.images ? { images: input.images.map(image => ({ ...image })) } : {}),
    }, context));
    this.currentOperationId = admission.operationId;
    this.turnCount = 0;
    this.warned = false;
    return admission.operationId;
  }

  drive(operationId: string): Promise<DriveResult> {
    this.assertOpen();
    const existing = this.drives.get(operationId);
    if (existing) return existing;
    const run = (async (): Promise<DriveResult> => {
      // A caller's observation signal never owns this drive or its resource occupancy.
      const outcome = getOrThrow(await this.lane.drive({ operationId, waitForRetry: true, pollDeferred: true }, context));
      await this.policyWork;
      if (this.policyError) throw this.policyError;
      return outcome.kind === "settled"
        ? { kind: "settled", result: await this.result(outcome.outcome) }
        : { kind: "waiting", operationId, reason: outcome.reason, ...(outcome.reason === "retry" ? { notBefore: outcome.notBefore } : {}) };
    })().finally(() => this.drives.delete(operationId));
    this.drives.set(operationId, run);
    return run;
  }

  async requestAbort(operationId: string): Promise<void> {
    this.assertOpen();
    getOrThrow(await this.lane.requestAbort(operationId, context));
  }

  async queue(kind: "steer" | "followUp", input: TaskInput): Promise<string> {
    this.assertOpen();
    return getOrThrow(await this.lane[kind](input.text, input.images?.map(image => ({ ...image })), context)).entryId;
  }

  async cancelQueued(entryId: string): Promise<"cancelled" | "already_consumed" | "not_found"> {
    this.assertOpen();
    return getOrThrow(await this.lane.cancelQueued(entryId, context)).kind;
  }

  async snapshot(): Promise<ExecutionSnapshot> {
    this.assertOpen();
    const watch = await this.lane.watch(context);
    const state = watch.snapshot;
    watch.unsubscribe();
    return Object.freeze({
      operation: state.operation ? Object.freeze({ operationId: state.operation.id, cancelling: state.operation.status === "aborting" }) : undefined,
      lastResult: state.lastResult ? await this.result(state.lastResult) : undefined,
      messages: Object.freeze(messages(state.transcript)),
      queued: Object.freeze(state.queues.map(item => Object.freeze({
        entryId: item.entryId, kind: item.kind, text: item.type === "message" ? textOf(item.message) : "",
      }))),
      faulted: state.faulted,
    });
  }

  async observe(listener: () => void): Promise<() => void> {
    this.assertOpen();
    const watch = await this.lane.watch(context);
    const unsubscribe = () => { watch.unsubscribe(); this.subscriptions.delete(unsubscribe); };
    this.subscriptions.add(unsubscribe);
    watch.start(() => { if (!this.closing) listener(); });
    return unsubscribe;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      for (const unsubscribe of this.subscriptions) unsubscribe();
      try {
        await this.harness.close(context);
      } finally {
        // Harness.close seals effects but does not wait for already admitted tools to return.
        await Promise.allSettled([...this.drives.values(), this.policyWork]);
        await this.env.cleanup(context);
      }
    });
    return this.closing;
  }

  private async result(record: OperationResultRecord): Promise<ExecutionResult> {
    const entries = record.tipId === null ? [] : (await this.lane.findEntries({
      start: record.tipId, ...(record.fromTipId === null ? {} : { stopAtId: record.fromTipId }), order: "oldestFirst",
    }, context)).filter(entry => entry.id !== record.fromTipId);
    const assistant = entries.filter(entry => entry.type === "message" && entry.message.role === "assistant").at(-1);
    const text = assistant?.type === "message" ? textOf(assistant.message).trim() : "";
    let outcome: TaskOutcome;
    if (record.status === "failed") outcome = { status: "error", error: record.error?.message ?? "Native operation failed", result: text };
    else if (record.status === "aborted") outcome = { status: "aborted", result: text };
    else if (record.status === "declined") outcome = { status: "stopped", result: text };
    else if (!text) outcome = { status: "error", error: "Subagent completed without final assistant text" };
    else outcome = {
      status: this.store.binding.policy.limits.maxTurns !== undefined && turns(entries) >= this.store.binding.policy.limits.maxTurns ? "turn_limited" : "completed",
      result: text,
    };
    return Object.freeze({ operationId: record.operationId, outcome: Object.freeze(outcome), completedAt: record.endedAt,
      sourceEntryIds: Object.freeze(assistant ? [assistant.id] : []) });
  }

  private limitReminder(): string {
    const { maxTurns, graceTurns } = this.store.binding.policy.limits;
    return `You have reached your turn limit of ${maxTurns}. You have ${Math.max(1, graceTurns)} turn(s) left. Stop calling tools and write your final answer, including any unfinished work.`;
  }

  private installPolicy(): void {
    const { maxTurns, graceTurns } = this.store.binding.policy.limits;
    const prepareLimit = () => {
      if (maxTurns === undefined || this.turnCount < maxTurns || this.warned) return;
      this.warned = true;
      // Event delivery is serialized by Harness. Awaiting another event-producing Lane command inside it deadlocks.
      this.policyWork = this.lane.steer(this.limitReminder(), undefined, context).then(result => { getOrThrow(result); })
        .catch(error => { this.policyError = error; });
    };
    this.subscriptions.add(this.harness.events.on("turn_end", event => {
      if (event.runId !== this.currentOperationId || event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
      this.turnCount++;
      prepareLimit();
    }));
    this.subscriptions.add(this.harness.hooks.on("before_drive", () => { prepareLimit(); }));
    this.subscriptions.add(this.harness.hooks.on("before_request", async event => {
      await this.policyWork;
      if (this.policyError || (maxTurns !== undefined && this.turnCount >= maxTurns + Math.max(1, graceTurns))) {
        getOrThrow(await this.lane.requestAbort(event.runId, context));
      }
      return undefined;
    }));
    this.subscriptions.add(this.harness.hooks.on("after_response", ({ message }) => {
      if (message.stopReason !== "stop" || message.content.some(part => part.type === "toolCall")) return;
      const text = extractText(message.content).trim();
      const error = !text ? "Subagent completed without final assistant text"
        : /^call:[^\s{}]+\s*\{[\s\S]*\}\s*$/.test(text) ? `Subagent emitted unexecuted tool call text: ${text}` : undefined;
      return error ? { message: { ...message, stopReason: "error", errorMessage: error } } : undefined;
    }));
  }

  private assertOpen(): void {
    if (this.closing) throw new Error("Execution driver is closed");
  }
}
