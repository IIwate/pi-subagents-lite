import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentConfig, SystemPromptMode } from "./agents/types.js";

export type ThinkingLevel = ModelThinkingLevel;

// Note: see .agents/notes/implemented/bug-fix/2026-09-09-subagent-screen-retry-and-steering-visibility.md
export interface AgentRetryState {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  startAt: number;
  errorMessage?: string;
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string | null;
  platform: string;
}

// Note: see .agents/notes/implemented/architecture/2026-09-10-isolated-child-resources-and-tool-gates.md
export interface AcceptedRunPolicy {
  /** Deep-copied definition resolved when the Agent call is accepted. */
  definition: AgentConfig;
  registeredTools: string[];
  restrictToRegisteredTools: boolean;
  tools?: true | string[] | false;
  extensions: true | string[] | false;
  skills: true | string[] | false;
  systemPromptMode: SystemPromptMode;
  includeContextFiles: boolean;
  /** Canonical parent model identity used when this call was authorized. */
  parentModelKey: string;
}

export const SHORT_ID_LENGTH = 8;

export type AgentStatus = "queued" | "running" | "completed" | "turn_limited" | "aborted" | "stopped" | "error";

export type StopInitiator = "user" | "agent";

export interface AgentLifecycle {
  status: AgentStatus;
  startedAt: number;
  completedAt?: number;
  stoppedBy?: StopInitiator;
  /** Session-local pin timestamp. Pinned records are exempt from automatic cleanup. */
  pinnedAt?: number;
  /** Terminal cleanup time already spent paused by completed pin intervals. */
  cleanupExpiryPausedMs?: number;
  /** True once the final result is safely persisted in the parent session. */
  resultPersisted?: boolean;
  /**
   * Whether the parent has received the result through a foreground return
   * or a verified durable delivery receipt.
   * Cleanup preserves terminal records until this is set or the result is persisted.
   */
  resultConsumed?: boolean;
  /** True if user took over this session interactively in child view. */
  takenOver?: boolean;
}
