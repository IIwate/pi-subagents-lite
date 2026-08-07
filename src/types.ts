/**
 * Type definitions for the subagent system.
 */

import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DebugFaultKind } from "./agents/debug-fault.js";
import type { LifetimeUsage } from "./agents/usage.js";
import type { SubagentType, AgentConfig, AgentInvocation, SystemPromptMode } from "./agents/types.js";

/**
 * Thinking level for agent models.
 * Known levels: off, minimal, low, medium, high, xhigh, max.
 * Free-form strings are also allowed (provider-specific thinking maps).
 */
export type ThinkingLevel = string;

/** Resolved model + run-limit tunables shared by every spawn/run shape. */
export interface RunTunables {
  model?: Model<any>;
  /** Scope captured when the Agent call was accepted. */
  scopedModels?: ExtensionContext["scopedModels"];
  maxTurns?: number;
  thinkingLevel?: ThinkingLevel;
  /** True when thinkingLevel is the accepted-call snapshot, including undefined. */
  thinkingResolved?: boolean;
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
  onSessionSetupStarted?: () => void;
  onSessionSetupFinished?: () => void;
  onSessionCreated?: (session: AgentSession) => void | Promise<void>;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: LifetimeUsage) => void;
  onCompaction?: () => void;
}

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

/**
 * Coordinator-side spawn config shared by SpawnOptions and SpawnIntent.
 * The resolved run params that both the manager and coordinator agree on;
 * extends RunTunables with display/identity fields.
 */
export interface SpawnConfig extends RunTunables {
  acceptedPolicy: AcceptedRunPolicy;
  description: string;
  modelKey?: string;
  worktreePath?: string;
  /** Parent session and branch anchor captured when background work is accepted. */
  resultSessionId?: string;
  resultOriginEntryId?: string | null;
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
  /** Session-local pin timestamp. Pinned records are exempt from automatic cleanup. */
  pinnedAt?: number;
  /** Terminal cleanup time already spent paused by completed pin intervals. */
  cleanupExpiryPausedMs?: number;
  /** True once the final result is safely persisted in the parent session. */
  resultPersisted?: boolean;
  /**
   * Whether the parent has received the result through a foreground return
   * or a successfully settled background turn.
   * Cleanup preserves terminal records until this is set or the result is persisted.
   */
  resultConsumed?: boolean;
}

/**
 * Display-oriented fields: type name, description, invocation params.
 * Used by the agent list and management menus.
 */
interface AgentDisplayInfo {
  type: SubagentType;
  description: string;
  /** Resolved spawn params, captured for UI display. Fixed at spawn time. */
  invocation?: AgentInvocation;
}

/**
 * Execution internals: session handle, abort controller, pending steers.
 * Used by agent-manager (session lifecycle), tool-execution (steering, nudge).
 */
interface AgentExecutionState {
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  /** Whether the current execution promise has fully settled. */
  settled?: boolean;
  /** Resolved model key used for concurrency accounting. */
  modelKey?: string;
  /** Grace turns retained for direct follow-up prompts. */
  graceTurns?: number;
  /** Parent session and branch anchor captured with the accepted invocation. */
  resultSessionId?: string;
  resultOriginEntryId?: string | null;
  /** Unique final-result identity currently represented by the record. */
  resultDeliveryId?: string;
  /** Debug fault assigned after the real child session is configured. */
  debugFaultKind?: DebugFaultKind;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: Array<{ message: string; images?: ImageContent[] }>;
}

/**
 * Accumulated statistics: usage breakdown, tool uses, turn count.
 * Used by the agent list and selected-session footer.
 */
interface AgentAccumulatedStats {
  /**
   * Lifetime usage breakdown, accumulated from assistant/tool events and
   * compactions. Total = input + output + cacheWrite + cost (cacheRead deliberately
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

