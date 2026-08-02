/**
 * config/types.ts — Persisted config shapes for subagents-lite.json.
 *
 * Model policy lives under modelRouting: the routing switch, the extra
 * provider allowlist, and per-agent model assignments. The agent object
 * holds only real agent settings (background, thinking, prompt, display) —
 * never dynamic model keys.
 */

import type { SystemPromptMode } from "../agents/types.js";
import type { ThinkingLevel } from "../types.js";

/** Cross-provider routing policy: switch, allowed providers, per-agent assignments. */
export interface ModelRoutingConfig {
  /** OFF: subagents use the exact parent model; assignments and explicit models are ignored. */
  enabled: boolean;
  /** Extra providers beyond the parent provider (which is implicit and always allowed). */
  allowedProviders: string[];
  /** Persistent per-agent model assignments: agent type → "provider/model". */
  agentModels: Record<string, string>;
}

/** Real agent settings. Model choices live in ModelRoutingConfig.agentModels. */
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

/** Shape of the subagents-lite.json config file. */
export interface SubagentsConfig {
  modelRouting: ModelRoutingConfig;
  agent: AgentSettings;
  concurrency: {
    default: number;
    providers?: Record<string, number>;
    models?: Record<string, number>;
  };
}

/**
 * Session-only per-agent model assignments. Never persisted — cleared at
 * session_start. No "default" key: the retired global default has no
 * successor, unassigned agents inherit the parent model.
 *
 * Three states per agent type:
 *   - key absent / undefined → no session assignment
 *   - string                  → this session uses that model
 *   - null                    → this session explicitly inherits the parent
 *                               model (shadows persistent assignments)
 */
export interface SessionModelOverrides {
  [agentType: string]: string | null | undefined;
}
