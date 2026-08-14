/**
 * agent-settings.ts — Composition seam for the `agent` configuration
 * fragment: spawn, prompt, and display policies that share one persisted
 * section. Resolution applies capability defaults on read; updates are
 * commit-first (REQ-CONFIG-001), so a failed save keeps the previous
 * effective value and never synchronizes the navigator with an unpersisted
 * value. One store is created per ExtensionRuntime by the composition root,
 * bound to that runtime's navigator.
 */

import type { SystemPromptMode } from "../agents/types.js";
import type { JsonValue } from "../modules/configuration/public.js";
import { DEFAULT_GRACE_TURNS } from "../modules/subagent-runtime/public.js";
import type { ConfigSectionIO } from "./configuration.js";

const VALID_SYSTEM_PROMPT_MODES = new Set<string>(["replace", "inherit", "custom"]);

/** Persisted shape of the `agent` section; every key optional on disk. */
interface AgentSettings {
  forceBackground?: boolean;
  graceTurns?: number;
  showCost?: boolean;
  systemPromptMode?: SystemPromptMode;
  includeContextFiles?: boolean;
  loadSkillsImplicitly?: boolean;
  loadExtensionsImplicitly?: boolean;
  disableDefaultAgents?: boolean;
  expandListByDefault?: boolean;
  showTools?: boolean;
  showTurns?: boolean;
  showInput?: boolean;
  showOutput?: boolean;
  showContext?: boolean;
  showTime?: boolean;
}

/**
 * Known agent setting keys. Unknown keys (legacy dynamic model keys, the
 * retired `default`) are dropped at load, so the next explicit save writes
 * the canonical schema. This is schema hygiene, not migration: old model
 * values are never read or transformed.
 */
const AGENT_SETTING_KEYS: readonly (keyof AgentSettings)[] = [
  "forceBackground",
  "graceTurns",
  "showCost",
  "systemPromptMode",
  "includeContextFiles",
  "loadSkillsImplicitly",
  "loadExtensionsImplicitly",
  "disableDefaultAgents",
  "expandListByDefault",
  "showTools",
  "showTurns",
  "showInput",
  "showOutput",
  "showContext",
  "showTime",
];

/** Agent settings with all scalar defaults resolved. */
export interface ResolvedAgentSettings {
  readonly forceBackground: boolean;
  readonly showCost: boolean;
  readonly graceTurns: number;
  /** System prompt mode: replace (default), inherit parent, or custom file. */
  readonly systemPromptMode: SystemPromptMode;
  /** Whether to include AGENTS.md context files in the subagent system prompt. */
  readonly includeContextFiles: boolean;
  /** Global default for skills loading: true (load all) or false (none). */
  readonly loadSkillsImplicitly: boolean;
  /** Global default for extensions loading: true (load all) or false (none). */
  readonly loadExtensionsImplicitly: boolean;
  /** Whether built-in default agent types are available for new calls. */
  readonly disableDefaultAgents: boolean;
  /** Whether new conversations start with the subagent list expanded. */
  readonly expandListByDefault: boolean;
  /** Whether to show toolUses count in list stats. */
  readonly showTools: boolean;
  /** Whether to show turn count in list stats. */
  readonly showTurns: boolean;
  /** Whether to show input tokens in list stats. */
  readonly showInput: boolean;
  /** Whether to show output tokens in list stats. */
  readonly showOutput: boolean;
  /** Whether to show context percent and compactions in list stats. */
  readonly showContext: boolean;
  /** Whether to show elapsed time in list stats. */
  readonly showTime: boolean;
}

/** The navigator surface this seam synchronizes after successful commits. */
export interface StatsNavigator {
  setStatsVisibility(visibility: {
    showTools: boolean;
    showTurns: boolean;
    showInput: boolean;
    showOutput: boolean;
    showContext: boolean;
    showCost: boolean;
    showTime: boolean;
  }): void;
}

export interface AgentSettingsStore {
  read(): ResolvedAgentSettings;
  update<K extends keyof AgentSettings>(
    key: K,
    value: NonNullable<AgentSettings[K]>,
  ): { ok: true } | { ok: false; message: string };
  /** Push current stats visibility into the navigator; no-op without one. */
  syncNavigatorStats(): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createAgentSettingsStore(
  io: ConfigSectionIO,
  navigator: () => StatsNavigator | null,
): AgentSettingsStore {
  const rawSettings = (): AgentSettings => {
    const raw = io.read("agent");
    const source = isPlainObject(raw) ? raw : {};
    const settings: AgentSettings = {};
    for (const key of AGENT_SETTING_KEYS) {
      const value = source[key];
      if (value !== undefined) (settings as Record<string, unknown>)[key] = value;
    }
    return settings;
  };

  const store: AgentSettingsStore = {
    read() {
      const a = rawSettings();
      return {
        forceBackground: a.forceBackground === true,
        showCost: a.showCost === true,
        graceTurns: a.graceTurns ?? DEFAULT_GRACE_TURNS,
        systemPromptMode: VALID_SYSTEM_PROMPT_MODES.has(a.systemPromptMode as string)
          ? (a.systemPromptMode as SystemPromptMode)
          : "replace",
        includeContextFiles: a.includeContextFiles ?? true,
        loadSkillsImplicitly: a.loadSkillsImplicitly !== false,
        loadExtensionsImplicitly: a.loadExtensionsImplicitly !== false,
        disableDefaultAgents: a.disableDefaultAgents === true,
        expandListByDefault: a.expandListByDefault !== false,
        showTools: a.showTools !== false,
        showTurns: a.showTurns !== false,
        showInput: a.showInput !== false,
        showOutput: a.showOutput !== false,
        showContext: a.showContext !== false,
        showTime: a.showTime !== false,
      };
    },
    update(key, value) {
      const candidate = { ...rawSettings(), [key]: value };
      const assignments = JSON.parse(JSON.stringify(candidate)) as Record<string, JsonValue>;
      const result = io.commit("agent", assignments);
      if (!result.ok) return result;
      store.syncNavigatorStats();
      return { ok: true };
    },
    syncNavigatorStats() {
      const target = navigator();
      if (!target) return;
      const a = store.read();
      target.setStatsVisibility({
        showTools: a.showTools,
        showTurns: a.showTurns,
        showInput: a.showInput,
        showOutput: a.showOutput,
        showContext: a.showContext,
        showCost: a.showCost,
        showTime: a.showTime,
      });
    },
  };
  return store;
}
