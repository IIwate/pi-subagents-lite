/**
 * Host-side shared types: prompt environment, runner callbacks, and the
 * coordinator spawn config. Lifecycle and record shapes live in the
 * subagent-runtime module contracts.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { LifetimeUsage } from "./agents/usage.js";
import type {
  AcceptedRunPolicy as AcceptedRunPolicyContract,
  AgentInvocation as AgentInvocationContract,
} from "./modules/subagent-runtime/public.js";

export type {
  AcceptedRunPolicy,
  ThinkingLevel,
} from "./modules/subagent-runtime/public.js";

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

/**
 * Coordinator-side spawn config shared by SpawnOptions and SpawnIntent.
 * Runtime policy has one source here; duplicated mutable fields would let
 * queued work remember whichever copy a later caller happened to read.
 */
export interface SpawnConfig {
  acceptedPolicy: AcceptedRunPolicyContract;
  description: string;
  worktreePath?: string;
  /** Parent session and branch anchor captured when background work is accepted. */
  resultSessionId?: string;
  resultOriginEntryId?: string | null;
  invocation?: AgentInvocationContract;
}

/** How many characters of agent ID to show in display. */
export const SHORT_ID_LENGTH = 8;

