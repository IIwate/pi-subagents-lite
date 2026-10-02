import type { AssistantMessage } from "@earendil-works/pi-ai";
import { extractText } from "../prompt/context.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Session, type ConversationId, type EntryRecord, type Cursor } from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { freezePolicy, type TaskPolicy } from "../domain/policy.js";
import type { ExecutionResult, DeliveryReceipt, ParentOrigin, StoredDelivery, TaskBinding, TaskDelivery, TaskStore, TaskInput } from "../engine/contracts.js";

export const TaskDocument = defineDoc<any>({ kind: "subagents-lite.task", version: 1, scope: "session",
  initial: () => ({ operations: {}, queue: [], deliveries: {}, extensionState: [], labels: {} }) });
const context = BACKGROUND_CONTEXT;

export interface PendingInput { id: string; kind: "steer" | "followUp"; input: TaskInput; }
// Note: see .agents/notes/implemented/architecture/2026-10-02-pi-1-0-execution-layer-migration-to-pi-durable.md
export interface Operation {
  id: string;
  input: TaskInput;
  startedAt: number;
  fromEntryId: number | null;
  stoppedBy?: "user" | "agent";
  cancelled?: boolean;
  result?: ExecutionResult;
}

function object(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid task data object");
  return input as Record<string, unknown>;
}

function string(input: unknown): string {
  if (typeof input !== "string" || !input) throw new Error("Invalid task data string");
  return input;
}

function strings(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error("Invalid task data array");
  return input.map(string);
}

function number(input: unknown, minimum = 0): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum) throw new Error("Invalid task data number");
  return input;
}

function stopInitiator(input: unknown): "user" | "agent" | undefined {
  if (input !== undefined && input !== "user" && input !== "agent") throw new Error("Invalid task stop initiator");
  return input;
}

function parent(input: unknown): ParentOrigin {
  const data = object(input);
  return Object.freeze({ sessionId: string(data.sessionId), entryId: data.entryId === null ? null : string(data.entryId) });
}

function parseBinding(input: unknown): TaskBinding {
  const data = object(input);
  const policy = object(data.policy);
  const model = object(policy.model);
  const limits = object(policy.limits);
  const thinkingLevel = policy.thinkingLevel;
  if (thinkingLevel !== "off" && thinkingLevel !== "minimal" && thinkingLevel !== "low" && thinkingLevel !== "medium"
    && thinkingLevel !== "high" && thinkingLevel !== "xhigh" && thinkingLevel !== "max") throw new Error("Invalid task thinking level");
  if (data.mode !== "foreground" && data.mode !== "background") throw new Error("Invalid task delivery mode");
  if (data.control !== "autonomous" && data.control !== "manual") throw new Error("Invalid task control mode");
  if (typeof policy.systemPrompt !== "string") throw new Error("Invalid task system prompt");
  if (policy.toolSources !== undefined && !Array.isArray(policy.toolSources)) throw new Error("Invalid task tool sources");
  const accepted: TaskPolicy = {
    agent: string(policy.agent), model: { provider: string(model.provider), id: string(model.id) },
    thinkingLevel, tools: strings(policy.tools), cwd: string(policy.cwd), systemPrompt: policy.systemPrompt,
    ...(policy.toolSources === undefined ? {} : { toolSources: (policy.toolSources as unknown[]).map(input => {
      const grant = object(input);
      return { source: string(grant.source), tools: grant.tools === true ? true as const : strings(grant.tools), exclude: strings(grant.exclude) };
    }) }),
    limits: {
      maxTurns: limits.maxTurns === undefined ? undefined : number(limits.maxTurns, 1),
      graceTurns: number(limits.graceTurns),
      maxTokens: limits.maxTokens === undefined ? undefined : number(limits.maxTokens, 1),
    },
  };
  const display = data.display === undefined ? undefined : object(data.display);
  const resources = data.resources === undefined ? undefined : object(data.resources);
  if (display && (typeof display.name !== "string" || typeof display.description !== "string")) throw new Error("Invalid task display text");
  if (resources && typeof resources.trusted !== "boolean") throw new Error("Invalid task resource trust");
  return Object.freeze({ taskId: string(data.taskId), policy: freezePolicy(accepted), parent: parent(data.parent), mode: data.mode, control: data.control,
    display: display ? Object.freeze({ name: display.name as string, description: display.description as string }) : undefined,
    resources: resources ? Object.freeze({ extensions: Object.freeze(strings(resources.extensions)), trusted: resources.trusted as boolean }) : undefined });
}

function parseStoredDelivery(input: unknown): StoredDelivery {
  const stored = object(input);
  const data = object(stored.delivery);
  const status = data.status;
  if (status !== "completed" && status !== "turn_limited" && status !== "error" && status !== "aborted" && status !== "stopped") {
    throw new Error("Invalid delivery status");
  }
  if (data.kind !== "automatic" && data.kind !== "selection") throw new Error("Invalid delivery kind");
  const delivery: TaskDelivery = {
    deliveryId: string(data.deliveryId), taskId: string(data.taskId), operationId: string(data.operationId),
    parent: parent(data.parent), kind: data.kind, status, text: string(data.text),
    sourceEntryIds: strings(data.sourceEntryIds), createdAt: number(data.createdAt),
  };
  if (stored.receipt === undefined) return { delivery };
  const receipt = object(stored.receipt);
  if (receipt.deliveryId !== delivery.deliveryId || receipt.parentSessionId !== delivery.parent.sessionId) {
    throw new Error("Delivery receipt identity mismatch");
  }
  return { delivery, receipt: { deliveryId: delivery.deliveryId, parentSessionId: delivery.parent.sessionId, entryId: string(receipt.entryId) } };
}

/** Accepted input and application receipts have a lifetime independent of native tool tasks. */
export class NativeTaskStore implements TaskStore {
  private constructor(readonly session: Session, private current: TaskBinding, readonly path?: string) {}

  static async open(session: Session, binding?: TaskBinding, path?: string): Promise<NativeTaskStore> {
    const saved = await session.snapshot(TaskDocument, context);
    if (saved?.binding && binding) throw new Error("The native session already owns a task");
    if (!saved?.binding && !binding) throw new Error("The native session has no task binding");
    const accepted = parseBinding(saved?.binding ?? JSON.parse(JSON.stringify(binding)));
    if (!saved?.binding) await session.commit(async tx => { (await tx.doc(TaskDocument)).binding = JSON.parse(JSON.stringify(accepted)); }, context);
    const store = new NativeTaskStore(session, accepted, path);
    await store.operations();
    await store.deliveries();
    await store.pending();
    await store.currentOperation();
    return store;
  }

  get binding(): TaskBinding { return this.current; }
  async data() { return (await this.session.snapshot(TaskDocument, context))!; }
  async operations(): Promise<Record<string, Operation>> {
    const data = object((await this.data()).operations);
    for (const [id, raw] of Object.entries(data)) {
      const op = object(raw); if (string(op.id) !== id) throw new Error("Operation identity mismatch");
      number(op.startedAt); if (op.fromEntryId !== null) number(op.fromEntryId);
      const input = object(op.input); if (typeof input.text !== "string") throw new Error("Invalid task input");
      if (input.images !== undefined && (!Array.isArray(input.images) || input.images.some(raw => {
        const image = object(raw); return image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string";
      }))) throw new Error("Invalid task images");
      if (op.result !== undefined) {
        const result = object(op.result); const outcome = object(result.outcome);
        if (result.operationId !== id || !["completed", "turn_limited", "error", "aborted", "stopped"].includes(string(outcome.status))) throw new Error("Invalid saved task result");
        if (outcome.result !== undefined && typeof outcome.result !== "string") throw new Error("Invalid saved task result text");
        if (outcome.error !== undefined && typeof outcome.error !== "string") throw new Error("Invalid saved task error");
        number(result.startedAt); number(result.completedAt); strings(result.sourceEntryIds);
        stopInitiator(result.stopRequestedBy); stopInitiator(outcome.stoppedBy);
      }
      stopInitiator(op.stoppedBy);
      if (op.cancelled !== undefined && typeof op.cancelled !== "boolean") throw new Error("Invalid task cancellation");
    }
    return data as unknown as Record<string, Operation>;
  }
  async currentOperation(): Promise<Operation | undefined> {
    const data = await this.data();
    if (data.current === undefined) return;
    const operations = await this.operations(); const id = string(data.current);
    if (!Object.hasOwn(operations, id)) throw new Error("Current task operation is missing");
    return operations[id];
  }
  async accept(input: TaskInput, fromEntryId: number | null): Promise<string> {
    const id = randomUUID();
    await this.session.commit(async tx => {
      const data = await tx.doc(TaskDocument);
      if (data.current && !data.operations[data.current].result) throw new Error("Task is already running");
      data.operations[id] = JSON.parse(JSON.stringify({ id, input, fromEntryId, startedAt: Date.now() })); data.current = id;
    }, context);
    return id;
  }
  async latestResult(): Promise<ExecutionResult | undefined> {
    const operation = await this.currentOperation();
    if (!operation || operation.result) return operation?.result;
    const root = await this.session.commit(async tx => (await tx.scanConversations({}, 1)).items[0], context);
    if (!root) return;
    const submission = await this.session.commit(tx => tx.submissionByRequest(root.id, operation.id), context);
    if (submission?.status === "done" || submission?.status === "unanswered") return this.result(operation.id, root.id);
  }
  async result(operationId: string, conversationId: ConversationId, requestError?: string): Promise<ExecutionResult> {
    const operation = (await this.operations())[operationId];
    if (!operation) throw new Error("Unknown task operation");
    if (operation.result) return operation.result;
    const { submission, entries } = await this.session.commit(async tx => {
      const submission = await tx.submissionByRequest(conversationId, operationId);
      const entries: EntryRecord[] = []; let cursor: Cursor | undefined;
      do {
        const page = await tx.scanEntries({ conversationId }, 256, cursor);
        entries.push(...page.items.filter(entry => operation.fromEntryId === null || entry.id > operation.fromEntryId)); cursor = page.next;
      } while (cursor !== undefined);
      return { submission, entries: entries.sort((a, b) => a.id - b.id) };
    }, context);
    const assistant = [...entries].reverse().find(entry => entry.model?.some(message => message.role === "assistant"));
    const message = assistant?.model?.find(message => message.role === "assistant") as AssistantMessage | undefined;
    const text = message ? extractText(message.content).trim() : "";
    const turns = entries.filter(entry => entry.model?.some(message => message.role === "assistant" && !["error", "aborted", "pending", "deferred"].includes(message.stopReason))).length;
    const max = this.binding.policy.limits.maxTurns;
    const error = requestError ?? message?.errorMessage;
    const cancelled = operation.cancelled || submission?.reason === "aborted";
    const outcome: ExecutionResult["outcome"] = cancelled ? { status: operation.stoppedBy ? "stopped" : "aborted", stoppedBy: operation.stoppedBy, result: text }
      : error?.includes("turn limit reached") ? { status: "aborted", result: text }
      : max !== undefined && turns >= max && submission?.status === "done" ? { status: "turn_limited", result: text }
      : submission?.status !== "done" || !text || requestError ? { status: "error", error: error ?? submission?.reason ?? "Subagent completed without final assistant text", result: text }
      : { status: "completed", result: text };
    const result = { operationId, outcome, startedAt: operation.startedAt, completedAt: message?.timestamp ?? Date.now(),
      stopRequestedBy: operation.stoppedBy, sourceEntryIds: assistant ? [String(assistant.id)] : [] };
    await this.saveResult(result); return result;
  }
  async saveResult(result: ExecutionResult): Promise<void> {
    await this.session.commit(async tx => {
      const data = await tx.doc(TaskDocument);
      if (!data.operations[result.operationId]) throw new Error("Unknown task operation");
      const operation = data.operations[result.operationId];
      operation.result = JSON.parse(JSON.stringify({ ...result, stopRequestedBy: operation.stoppedBy ?? result.stopRequestedBy }));
    }, context);
  }
  async pending(): Promise<PendingInput[]> {
    const queue = (await this.data()).queue;
    if (!Array.isArray(queue)) throw new Error("Invalid pending input queue");
    for (const raw of queue) {
      const item = object(raw); string(item.id);
      if (item.kind !== "steer" && item.kind !== "followUp") throw new Error("Invalid pending input kind");
      if (typeof object(item.input).text !== "string") throw new Error("Invalid pending input");
    }
    return queue;
  }
  async enqueue(kind: PendingInput["kind"], input: TaskInput): Promise<string> {
    const id = randomUUID();
    await this.session.commit(async tx => { (await tx.doc(TaskDocument)).queue.push(JSON.parse(JSON.stringify({ id, kind, input }))); }, context);
    return id;
  }
  async removePending(id: string): Promise<boolean> {
    let removed = false;
    await this.session.commit(async tx => { const data = await tx.doc(TaskDocument); const index = data.queue.findIndex((item: PendingInput) => item.id === id);
      if (index >= 0) { data.queue.splice(index, 1); removed = true; }
    }, context);
    return removed;
  }
  async recordStop(operationId: string, initiator?: "user" | "agent"): Promise<void> {
    await this.session.commit(async tx => {
      const data = await tx.doc(TaskDocument); const operation = data.operations[operationId];
      if (!operation) throw new Error("Unknown task operation");
      operation.cancelled = true;
      if (operation.stoppedBy !== "user" && initiator) operation.stoppedBy = initiator;
      if (operation.result && operation.stoppedBy) operation.result.stopRequestedBy = operation.stoppedBy;
      const id = `automatic:${this.current.taskId}:${operationId}`;
      if (operation.stoppedBy === "user" && data.deliveries[id] && !data.deliveries[id].receipt) delete data.deliveries[id];
    }, context);
  }
  async takeOver(): Promise<void> {
    await this.session.commit(async tx => { (await tx.doc(TaskDocument)).binding.control = "manual"; }, context);
    this.current = Object.freeze({ ...this.current, control: "manual" });
  }
  async saveDelivery(delivery: TaskDelivery, eligible: () => boolean = () => true): Promise<void> {
    this.checkDelivery(delivery);
    await this.session.commit(async tx => {
      const data = await tx.doc(TaskDocument); const existing = data.deliveries[delivery.deliveryId];
      if (existing) {
        if (!isDeepStrictEqual(parseStoredDelivery(existing).delivery, delivery)) throw new Error("Delivery ID already belongs to a different result");
        return;
      }
      if ((delivery.kind === "automatic" && data.operations[delivery.operationId]?.stoppedBy === "user") || !eligible()) return;
      data.deliveries[delivery.deliveryId] = JSON.parse(JSON.stringify({ delivery }));
    }, context);
  }
  async deliveries(): Promise<readonly StoredDelivery[]> {
    return Object.values(object((await this.data()).deliveries)).map(raw => {
      const stored = parseStoredDelivery(raw); this.checkDelivery(stored.delivery); return stored;
    });
  }
  async acknowledge(receipt: DeliveryReceipt): Promise<void> {
    await this.session.commit(async tx => {
      const data = await tx.doc(TaskDocument); const saved = data.deliveries[receipt.deliveryId];
      if (!saved) throw new Error("Cannot acknowledge an unknown delivery");
      const stored = parseStoredDelivery(saved); this.checkDelivery(stored.delivery);
      if (receipt.parentSessionId !== stored.delivery.parent.sessionId) throw new Error("Delivery receipt parent mismatch");
      if (stored.receipt && stored.receipt.entryId !== receipt.entryId) throw new Error("Delivery already has a different durable receipt");
      saved.receipt = { ...receipt };
    }, context);
  }
  private checkDelivery(delivery: TaskDelivery): void {
    if (delivery.taskId !== this.current.taskId || delivery.parent.sessionId !== this.current.parent.sessionId
      || (delivery.kind === "automatic" && delivery.parent.entryId !== this.current.parent.entryId)) throw new Error("Delivery does not belong to this task");
  }
}
