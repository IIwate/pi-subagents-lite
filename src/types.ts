/**
 * Type definitions for the subagent system.
 */

import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { DebugFaultKind } from "./agents/debug-fault.js";
import type { LifetimeUsage } from "./agents/usage.js";
import type { SubagentType, AgentInvocation } from "./agents/types.js";

/**
 * Thinking level for agent models.
 * Known levels: off, minimal, low, medium, high, xhigh, max.
 * Free-form strings are also allowed (provider-specific thinking maps).
 */
export type ThinkingLevel = string;

/** Resolved model + run-limit tunables shared by every spawn/run shape. */
export interface RunTunables {
  model?: Model<any>;
  maxTurns?: number;
  thinkingLevel?: ThinkingLevel;
  graceTurns?: number;
}

export interface AgentRecord {
  id: string;
  result?: string;
  error?: string;
  /** Lifecycle state: status, timestamps. */
  lifecycle: AgentLifecycle;
  /** Display-oriented info: type, description, invocation. */
  display: AgentDisplayInfo;
  /** Execution internals: session, abort controller, pending steers. */
  execution: AgentExecutionState;
  /** Accumulated statistics: usage, tool uses, turns. */
  stats: AgentAccumulatedStats;
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string | null;
  platform: string;
}

/** Internal runner events consumed by AgentManager record tracking. */
export interface RunCallbacks {
  onToolUse?: () => void;
  onSessionCreated?: (session: AgentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: LifetimeUsage) => void;
  onCompaction?: () => void;
}

/**
 * Coordinator-side spawn config shared by SpawnOptions and SpawnIntent.
 * The resolved run params that both the manager and coordinator agree on;
 * extends RunTunables with display/identity fields.
 */
export interface SpawnConfig extends RunTunables {
  description: string;
  modelKey?: string;
  worktreePath?: string;
  invocation?: AgentInvocation;
}

/** How many characters of agent ID to show in display. */
export const SHORT_ID_LENGTH = 8;

// ---------------------------------------------------------------------------
// Sub-object interfaces for decomposed AgentRecord
// ---------------------------------------------------------------------------

/** Possible agent lifecycle statuses. */
export type AgentStatus = "queued" | "running" | "completed" | "turn_limited" | "aborted" | "stopped" | "error";

/** Who initiated an agent stop: "user" via UI menu, or "agent" via StopAgent tool. */
export type StopInitiator = "user" | "agent";

/**
 * Lifecycle state: when the agent started, completed, and its current status.
 * Used by agent-manager (lifecycle control), menus (status display), widget (linger logic).
 */
export interface AgentLifecycle {
  status: AgentStatus;
  startedAt: number;
  completedAt?: number;
  stoppedBy?: StopInitiator;
  /**
   * Whether the result has been read by the LLM (foreground return or background nudge).
   * cleanup() preserves terminal records until this is set, so a completed background
   * agent whose nudge hasn't fired yet isn't evicted before the LLM reads the result.
   */
  resultConsumed?: boolean;
}

/**
 * Display-oriented fields: type name, description, invocation params.
 * Used by the agent list and management menus.
 */
export interface AgentDisplayInfo {
  type: SubagentType;
  description: string;
  /** Resolved spawn params, captured for UI display. Fixed at spawn time. */
  invocation?: AgentInvocation;
}

/**
 * Execution internals: session handle, abort controller, pending steers.
 * Used by agent-manager (session lifecycle), tool-execution (steering, nudge).
 */
export interface AgentExecutionState {
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  /** Whether the current execution promise has fully settled. */
  settled?: boolean;
  /** Resolved model key used for concurrency accounting. */
  modelKey?: string;
  /** Grace turns retained for direct follow-up prompts. */
  graceTurns?: number;
  /** Debug fault assigned after the real child session is configured. */
  debugFaultKind?: DebugFaultKind;
  /** One-shot Debug recovery window for a fault-injected failure. */
  recoveryTtlMs?: number;
  /** Absolute expiry for an active recovery window; kept separate from failure time. */
  recoveryExpiresAt?: number;
  /** Frozen remaining recovery time while the user is viewing the failed child session. */
  recoveryExpiryPausedRemainingMs?: number;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: Array<{ message: string; images?: ImageContent[] }>;
}

/**
 * Accumulated statistics: usage breakdown, tool uses, turn count.
 * Used by the agent list and selected-session footer.
 */
export interface AgentAccumulatedStats {
  /**
   * Lifetime usage breakdown, accumulated via `message_end` events. Survives
   * compaction. Total = input + output + cacheWrite + cost (cacheRead deliberately
   * excluded — see issue #38). Initialized to zeros at spawn.
   */
  lifetimeUsage: LifetimeUsage;
  toolUses: number;
  /** Final turn count (set on completion). Used by widget after activity cleanup. */
  turnCount?: number;
  /** Max turns limit (from invocation or default). */
  maxTurns?: number;
  /** Number of times this agent's session has compacted. Initialized to 0 at spawn. */
  compactionCount: number;
  /** Last-known context usage percentage (0–100), captured at completion. */
  contextPercent?: number | null;
}

