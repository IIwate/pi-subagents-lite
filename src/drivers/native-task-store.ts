import { BACKGROUND_CONTEXT, setValue, value, type Session } from "@earendil-works/pi-agent-core";
import { isDeepStrictEqual } from "node:util";
import { freezePolicy, type TaskPolicy } from "../domain/policy.js";
import type { DeliveryReceipt, ParentOrigin, StoredDelivery, TaskBinding, TaskDelivery, TaskStore } from "../engine/contracts.js";

const namespace = "subagents-lite.v3";
const taskAddress = value<unknown>(namespace, "task");
const deliveryAddress = (id = "") => value<unknown>(namespace, `delivery/${id}`);
const context = BACKGROUND_CONTEXT;

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
  const accepted: TaskPolicy = {
    agent: string(policy.agent), model: { provider: string(model.provider), id: string(model.id) },
    thinkingLevel, tools: strings(policy.tools), cwd: string(policy.cwd), systemPrompt: policy.systemPrompt,
    limits: {
      maxTurns: limits.maxTurns === undefined ? undefined : number(limits.maxTurns, 1),
      graceTurns: number(limits.graceTurns),
      maxTokens: limits.maxTokens === undefined ? undefined : number(limits.maxTokens, 1),
    },
  };
  return Object.freeze({ taskId: string(data.taskId), policy: freezePolicy(accepted), parent: parent(data.parent), mode: data.mode, control: data.control });
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

export class NativeTaskStore implements TaskStore {
  private constructor(private readonly session: Session, private current: TaskBinding) {}

  static async open(session: Session, binding?: TaskBinding): Promise<NativeTaskStore> {
    const saved = await session.getValue(taskAddress, context);
    let accepted: TaskBinding;
    if (saved) {
      if (binding) throw new Error("The native session already owns a task");
      accepted = parseBinding(saved.value);
    } else {
      if (!binding) throw new Error("The native session has no task binding");
      accepted = Object.freeze({ ...binding, policy: freezePolicy(binding.policy), parent: Object.freeze({ ...binding.parent }) });
    }
    if (session.metadata.parentSessionId !== accepted.parent.sessionId) throw new Error("Native task parent session mismatch");
    if (session.metadata.cwd !== undefined && session.metadata.cwd !== accepted.policy.cwd) throw new Error("Native task working directory mismatch");
    if (!saved) await session.setValue(taskAddress, accepted, context);
    return new NativeTaskStore(session, accepted);
  }

  get binding(): TaskBinding { return this.current; }

  async takeOver(): Promise<void> {
    if (this.current.control === "manual") return;
    const next: TaskBinding = Object.freeze({ ...this.current, control: "manual" });
    await this.session.setValue(taskAddress, next, context);
    this.current = next;
  }

  async saveDelivery(delivery: TaskDelivery): Promise<void> {
    this.checkDelivery(delivery);
    await this.session.mutate(async writer => {
      const address = deliveryAddress(delivery.deliveryId);
      const existing = await writer.getValue(address, context);
      if (existing) {
        if (!isDeepStrictEqual(parseStoredDelivery(existing.value).delivery, delivery)) {
          throw new Error("Delivery ID already belongs to a different result");
        }
        return;
      }
      await writer.commit([setValue(address, { delivery })], context);
    }, context);
  }

  async deliveries(): Promise<readonly StoredDelivery[]> {
    return (await this.session.scanValues(deliveryAddress(), context)).map(row => {
      const stored = parseStoredDelivery(row.value);
      this.checkDelivery(stored.delivery);
      return stored;
    });
  }

  async acknowledge(receipt: DeliveryReceipt): Promise<void> {
    await this.session.mutate(async writer => {
      const address = deliveryAddress(receipt.deliveryId);
      const saved = await writer.getValue(address, context);
      if (!saved) throw new Error("Cannot acknowledge an unknown delivery");
      const stored = parseStoredDelivery(saved.value);
      this.checkDelivery(stored.delivery);
      if (receipt.parentSessionId !== stored.delivery.parent.sessionId) throw new Error("Delivery receipt parent mismatch");
      if (stored.receipt) {
        if (stored.receipt.entryId !== receipt.entryId) throw new Error("Delivery already has a different durable receipt");
        return;
      }
      await writer.commit([setValue(address, { delivery: stored.delivery, receipt })], context);
    }, context);
  }

  private checkDelivery(delivery: TaskDelivery): void {
    if (delivery.taskId !== this.current.taskId || delivery.parent.sessionId !== this.current.parent.sessionId
      || (delivery.kind === "automatic" && delivery.parent.entryId !== this.current.parent.entryId)) {
      throw new Error("Delivery does not belong to this task");
    }
  }
}
