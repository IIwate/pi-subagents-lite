import type { ExecutionMessage, TaskInput } from "../engine/contracts.js";
import type { TaskOutcome } from "../domain/task.js";
import type { Theme } from "./types.js";
import type { StatsVisibility } from "./format.js";

export type NavigationStatus = "queued" | "running" | "waiting" | "cancelling" | "completed" | "turn_limited" | "aborted" | "stopped" | "error";

export interface NavigationAgent {
  readonly id: string;
  readonly operationId: string;
  readonly display: { readonly type: string; readonly name: string; readonly description: string };
  readonly lifecycle: {
    readonly status: NavigationStatus;
    readonly startedAt: number;
    readonly completedAt?: number;
    readonly pinnedAt?: number;
    readonly takenOver?: boolean;
  };
  readonly execution: {
    readonly settled: boolean;
    readonly providerName?: string;
    readonly modelName?: string;
    readonly thinkingLevel?: string;
    readonly retryState?: { readonly attempt: number; readonly maxAttempts: number; readonly delayMs: number; readonly startAt: number };
  };
  readonly stats: {
    readonly lifetimeUsage: { readonly input: number; readonly output: number; readonly cost: number };
    readonly toolUses: number;
    readonly turnCount?: number;
    readonly maxTurns?: number;
    readonly compactionCount: number;
    readonly contextPercent?: number | null;
  };
  readonly queued: readonly { readonly entryId: string; readonly kind: "steer" | "followUp" | "nextRun" | "write"; readonly input: TaskInput }[];
  readonly error?: string;
  readonly result?: string;
  readonly canDeliver: boolean;
}

export interface TranscriptSnapshot {
  readonly ready: boolean;
  readonly messages: readonly ExecutionMessage[];
  readonly streaming?: ExecutionMessage;
}

export interface DeliverySelection {
  readonly taskId: string;
  readonly operationId: string;
  readonly messages: readonly ExecutionMessage[];
  readonly createdAt: number;
  readonly status: TaskOutcome["status"];
}

// Note: see .agents/notes/implemented/architecture/2026-09-11-declarative-navigation-and-input-actions.md
export type NavigationAction =
  | { readonly type: "steer" | "followUp" | "continue"; readonly taskId: string; readonly operationId: string; readonly input: TaskInput }
  | { readonly type: "takeover" | "abort" | "abortRetry" | "pin" | "remove"; readonly taskId: string; readonly operationId: string }
  | { readonly type: "dequeue"; readonly taskId: string; readonly operationId: string; readonly entryIds: readonly string[] }
  | { readonly type: "deliver"; readonly selection: DeliverySelection; readonly deliveryId?: string };

export type NavigationReply =
  | { readonly accepted: true; readonly restored?: readonly TaskInput[]; readonly pinned?: boolean; readonly deliveryId?: string; readonly operationId?: string; readonly message?: string }
  | { readonly accepted: false; readonly reason: "concurrency" | "queued" | "unavailable" | "already_consumed" | "save_failed"; readonly modelKey?: string; readonly deliveryId?: string; readonly message?: string };

/** Display values and commands cross this boundary; execution handles do not. */
export interface NavigationSource {
  listAgents(): readonly NavigationAgent[];
  getRecord(taskId: string): NavigationAgent | undefined;
  transcript(taskId: string): TranscriptSnapshot;
  watchTranscript(taskId: string, listener: () => void): () => void;
  subscribe(listener: () => void): () => void;
  dispatch(action: NavigationAction): NavigationReply | Promise<NavigationReply>;
  dispose(): void;
}

export interface NavigatorViewState {
  readonly records: readonly NavigationAgent[];
  readonly selectedId: string | null;
  readonly highlightedId: string | null;
  readonly confirmingClearId: string | null;
  readonly listFocused: boolean;
  readonly listExpanded: boolean;
  readonly notice?: string;
  readonly pending?: number;
  readonly parentModel?: { readonly providerName?: string; readonly modelName?: string; readonly thinkingLevel?: string };
  readonly statsVisibility: StatsVisibility;
  readonly theme: Theme;
  readonly now: number;
}
