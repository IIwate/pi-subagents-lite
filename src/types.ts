/**
 * Host-agnostic shared types: prompt environment and the coordinator spawn
 * config. Lifecycle and record shapes live in the subagent-runtime module
 * contracts; runner callbacks that carry a vendor session object live with the
 * Pi session adapter that owns them.
 */

import type {
  AcceptedRunPolicy as AcceptedRunPolicyContract,
  AgentInvocation as AgentInvocationContract,
} from "./modules/subagent-runtime/public.js";

export type { AcceptedRunPolicy } from "./modules/subagent-runtime/public.js";
export type { ThinkingLevel } from "./modules/model-access/public.js";

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string | null;
  platform: string;
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

