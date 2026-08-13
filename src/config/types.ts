/**
 * config/types.ts — Persisted config shapes for subagents-lite.json.
 *
 * Model routing is an access policy: a global switch, globally enabled
 * providers, and per-agent provider/model grants. It never assigns a default
 * model; omitting Agent.model requests the exact parent model and still
 * requires that agent type's Parent model access.
 */

import type { SystemPromptMode } from "../agents/types.js";
import type { ThinkingLevel } from "../types.js";

export const CANONICAL_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];

export interface ProviderModelAccess {
  /** Omitted = all current provider models; non-empty = exact model IDs. */
  models?: string[];
}

export interface ThinkingAccessOverride {
  allowed: ThinkingLevel[];
  default: ThinkingLevel;
}

export interface AgentModelAccess {
  /** Omitted means allowed. */
  parentModelAccess?: boolean;
  providers: Record<string, ProviderModelAccess>;
  /** Exact canonical provider/model key to a saved policy override. */
  thinking?: Record<string, ThinkingAccessOverride>;
}

export interface ModelRoutingConfig {
  /** OFF permits only the exact parent model. */
  enabled: boolean;
  /** Providers globally enabled for alternate models. */
  enabledProviders: string[];
  /** Per-agent provider/model access rules. */
  agentAccess: Record<string, AgentModelAccess>;
}

export interface AgentSettings {
  forceBackground: boolean;
  graceTurns?: number;
  showCost?: boolean;
  /** System prompt mode: replace (default), inherit parent, or custom file. */
  systemPromptMode?: SystemPromptMode;
  /** Whether to include AGENTS.md context files in the subagent system prompt. Default: true. */
  includeContextFiles?: boolean;
  /** Global default for skills loading when agent doesn't explicitly set skills. true (default) or false. */
  loadSkillsImplicitly?: boolean;
  /** Global default for extensions loading when agent doesn't explicitly set extensions. true (default) or false. */
  loadExtensionsImplicitly?: boolean;
  /** When true, block new uses of built-in agent types (general-purpose, Explore). */
  disableDefaultAgents?: boolean;
  /** Whether new conversations start with the subagent list expanded. Default: true. */
  expandListByDefault?: boolean;
  /** Whether to show toolUses count in widget stats line. Default: true. */
  showTools?: boolean;
  /** Whether to show turn count in widget stats line. Default: true. */
  showTurns?: boolean;
  /** Whether to show input tokens in widget stats line. Default: true. */
  showInput?: boolean;
  /** Whether to show output tokens in widget stats line. Default: true. */
  showOutput?: boolean;
  /** Whether to show context percent and compactions in widget stats line. Default: true. */
  showContext?: boolean;
  /** Whether to show elapsed time in widget stats line. Default: true. */
  showTime?: boolean;
}

export interface SubagentsConfig {
  modelRouting: ModelRoutingConfig;
  agent: AgentSettings;
}
