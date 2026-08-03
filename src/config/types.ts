/**
 * config/types.ts — Persisted config shapes for subagents-lite.json.
 *
 * Model routing is an access policy: a global switch, globally enabled
 * providers, and per-agent provider/model grants. It never assigns a default
 * model; omitting Agent.model always selects the exact parent model.
 */

import type { SystemPromptMode } from "../agents/types.js";
import type { ThinkingLevel } from "../types.js";

export interface ProviderModelAccess {
  /** Omitted = all current provider models; non-empty = exact model IDs. */
  models?: string[];
}

export interface AgentModelAccess {
  providers: Record<string, ProviderModelAccess>;
}

export interface ModelRoutingConfig {
  /** OFF permits only the exact parent model. */
  enabled: boolean;
  /** Providers globally enabled for alternates; the current parent passes this gate dynamically. */
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
  /** Default thinking level for spawned agents. Undefined = inherit from agent config. */
  defaultThinking?: ThinkingLevel;
  /** Global default for skills loading when agent doesn't explicitly set skills. true (default) or false. */
  loadSkillsImplicitly?: boolean;
  /** Global default for extensions loading when agent doesn't explicitly set extensions. true (default) or false. */
  loadExtensionsImplicitly?: boolean;
  /** When true, skip built-in default agents (general-purpose, Explore) at registration. */
  disableDefaultAgents?: boolean;
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
  concurrency: {
    default: number;
    providers?: Record<string, number>;
    models?: Record<string, number>;
  };
}
