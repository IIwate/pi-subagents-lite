import type { TaskPolicy } from "../domain/policy.js";
import type { TaskOutcome } from "../domain/task.js";

export interface ParentOrigin {
  readonly sessionId: string;
  readonly entryId: string | null;
}

export interface TaskBinding {
  readonly taskId: string;
  readonly policy: TaskPolicy;
  readonly parent: ParentOrigin;
  readonly mode: "foreground" | "background";
  readonly control: "autonomous" | "manual";
}

export interface TaskInput {
  readonly text: string;
  readonly images?: readonly { readonly type: "image"; readonly data: string; readonly mimeType: string }[];
}

export interface ExecutionMessage {
  readonly entryId: string;
  readonly role: string;
  readonly text: string;
  readonly parts?: readonly (
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "thinking"; readonly thinking: string }
    | { readonly type: "toolCall"; readonly name: string; readonly arguments?: Readonly<Record<string, unknown>> }
    | { readonly type: "image" }
  )[];
  readonly toolName?: string;
  readonly isError?: boolean;
}

export interface QueuedInput {
  readonly entryId: string;
  readonly kind: "steer" | "followUp" | "nextRun" | "write";
  readonly text: string;
  readonly images?: TaskInput["images"];
}

export interface ExecutionResult {
  readonly operationId: string;
  readonly outcome: TaskOutcome;
  readonly completedAt: number;
  readonly startedAt: number;
  readonly sourceEntryIds: readonly string[];
}

export interface ExecutionSnapshot {
  readonly operation?: { readonly operationId: string; readonly cancelling: boolean; readonly startedAt: number };
  readonly lastResult?: ExecutionResult;
  readonly messages: readonly ExecutionMessage[];
  readonly streaming?: ExecutionMessage;
  readonly stats: { readonly input: number; readonly output: number; readonly cost: number; readonly toolUses: number; readonly turnCount: number; readonly compactions: number; readonly contextPercent: number | null };
  readonly retry?: { readonly attempt: number; readonly maxAttempts: number; readonly nextAttemptAt: number };
  readonly queued: readonly QueuedInput[];
  readonly faulted: boolean;
}

export type DriveResult =
  | { readonly kind: "settled"; readonly result: ExecutionResult }
  | { readonly kind: "waiting"; readonly operationId: string; readonly reason: "retry" | "deferred"; readonly notBefore?: number };

export interface TaskDelivery {
  readonly deliveryId: string;
  readonly taskId: string;
  readonly operationId: string;
  readonly parent: ParentOrigin;
  readonly kind: "automatic" | "selection";
  readonly status: TaskOutcome["status"];
  readonly text: string;
  readonly sourceEntryIds: readonly string[];
  readonly createdAt: number;
}

export interface DeliveryReceipt {
  readonly deliveryId: string;
  readonly parentSessionId: string;
  readonly entryId: string;
}

export interface StoredDelivery {
  readonly delivery: TaskDelivery;
  readonly receipt?: DeliveryReceipt;
}

/** Application data lives beside native operations, outside the conversation tree. */
export interface TaskStore {
  readonly binding: TaskBinding;
  takeOver(): Promise<void>;
  saveDelivery(delivery: TaskDelivery): Promise<void>;
  deliveries(): Promise<readonly StoredDelivery[]>;
  acknowledge(receipt: DeliveryReceipt): Promise<void>;
}

// Note: see .agents/notes/implemented/architecture/2026-09-11-native-execution-and-parent-delivery-adapters.md
export interface ExecutionDriver {
  readonly store: TaskStore;
  accept(input: TaskInput): Promise<string>;
  drive(operationId: string): Promise<DriveResult>;
  requestAbort(operationId: string): Promise<void>;
  queue(kind: "steer" | "followUp", input: TaskInput): Promise<string>;
  cancelQueued(entryId: string): Promise<"cancelled" | "already_consumed" | "not_found">;
  snapshot(): Promise<ExecutionSnapshot>;
  observe(listener: () => void): Promise<() => void>;
  close(): Promise<void>;
}

export type DeliveryAttempt =
  | { readonly status: "received"; readonly receipt: DeliveryReceipt }
  | { readonly status: "pending"; readonly reason: "busy" | "ineligible" | "not_durable" };

/** The implementation rechecks eligibility at its final parent write boundary. */
export interface DeliveryChannel {
  deliver(delivery: TaskDelivery, eligible: () => boolean): Promise<DeliveryAttempt>;
}
