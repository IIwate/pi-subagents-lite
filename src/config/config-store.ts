/**
 * config-store.ts — Transitional resolved-settings surface for the menus.
 *
 * Phase 7 migration state: the configuration module owns the persisted
 * document, revisions, and atomic fragment commits. This store keeps only the
 * legacy responsibilities that have not yet moved to the settings module:
 * resolved reads with capability defaults, the menu mutation surface, and the
 * manager/navigator synchronization side effects. Each settings slice deletes
 * the accessors it replaces; the store is removed with the last menu.
 */

import type { ChildScreenHost } from "../bootstrap/child-screen.js";
import type { ConfigSection, ConfigSectionIO } from "../bootstrap/configuration.js";
import type { JsonValue } from "../modules/configuration/public.js";
import type { AgentModelAccess, AgentSettings, ProviderModelAccess, SubagentsConfig, ThinkingAccessOverride } from "./types.js";
import {
  agentTypesForProvider,
  applyAgentProviderAccess,
  applyCleanUnavailableModels,
  applyClearModelAccess,
  applyDeleteProviderRules,
  applyParentModelAccess,
  applyProviderEnabled,
  applyQuickAgentProviderAccess,
  applyResetThinkingAccess,
  applyRoutingEnabled,
  applyThinkingAccess,
  parseModelAccessFragment,
} from "../modules/model-access/public.js";
import type { SystemPromptMode } from "../agents/types.js";
import type { ThinkingLevel } from "../types.js";

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Default number of grace turns before an agent is force-stopped. */
export const DEFAULT_GRACE_TURNS = 6;

/** Valid system prompt modes. */
export const VALID_SYSTEM_PROMPT_MODES = new Set<string>(["replace", "inherit", "custom"]);

/** Default agent settings — merged into loaded config so callers get a complete shape. */
const DEFAULT_AGENT: AgentSettings = {
  forceBackground: false,
  graceTurns: DEFAULT_GRACE_TURNS,
  systemPromptMode: "replace",
  includeContextFiles: true,
  disableDefaultAgents: false,
  expandListByDefault: true,
  showTools: true,
  showTurns: true,
  showInput: true,
  showOutput: true,
  showContext: true,
  showCost: false,
  showTime: true,
};

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

/** Resolved routing policy snapshot (copies, so callers cannot mutate the store). */
export interface ResolvedRoutingConfig {
  readonly enabled: boolean;
  readonly enabledProviders: string[];
  readonly agentAccess: Record<string, AgentModelAccess>;
}

/** Side-effect targets, injected after construction. */
export interface ConfigStoreDeps {
  navigator?: ChildScreenHost;
}

export class ConfigStore {
  private config: SubagentsConfig;
  private navigator?: ChildScreenHost;

  constructor(private readonly io: ConfigSectionIO) {
    this.config = this.loadFromSections();
  }

  // ── Reads ──────────────────────────────────────────────────────

  get agent(): ResolvedAgentSettings {
    const a = this.config.agent;

    return {
      forceBackground: a.forceBackground === true,
      showCost: a.showCost === true,
      graceTurns: a.graceTurns ?? DEFAULT_GRACE_TURNS,
      systemPromptMode: VALID_SYSTEM_PROMPT_MODES.has(a.systemPromptMode as string) ? (a.systemPromptMode as SystemPromptMode) : "replace",
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
  }

  get routing(): ResolvedRoutingConfig {
    const agentAccess: Record<string, AgentModelAccess> = {};
    for (const [type, access] of Object.entries(this.config.modelRouting.agentAccess)) {
      const providers: Record<string, ProviderModelAccess> = {};
      for (const [provider, rule] of Object.entries(access.providers)) {
        setOwn(providers, provider, rule.models ? { models: [...rule.models] } : {});
      }
      const thinking: Record<string, ThinkingAccessOverride> = {};
      for (const [key, override] of Object.entries(access.thinking ?? {})) {
        setOwn(thinking, key, { allowed: [...override.allowed], default: override.default });
      }
      setOwn(agentAccess, type, {
        ...(access.parentModelAccess === false ? { parentModelAccess: false } : {}),
        providers,
        ...(Object.keys(thinking).length > 0 ? { thinking } : {}),
      });
    }
    return {
      enabled: this.config.modelRouting.enabled,
      enabledProviders: [...this.config.modelRouting.enabledProviders],
      agentAccess,
    };
  }

  /** Agent types with saved Provider access or Thinking policy for one provider. */
  accessTypesForProvider(provider: string): string[] {
    return agentTypesForProvider(this.config.modelRouting, provider);
  }

  // ── Mutations ──────────────────────────────────────────────────
  // Each persisted method = mutate + persist (+ side effect).

  readonly mutate = {
    routing: {
      setEnabled: (enabled: boolean): void => {
        this.config.modelRouting = applyRoutingEnabled(this.config.modelRouting, enabled);
        this.persist("modelRouting");
      },
      setProviderEnabled: (provider: string, enabled: boolean): void => {
        this.config.modelRouting = applyProviderEnabled(this.config.modelRouting, provider, enabled);
        this.persist("modelRouting");
      },
      /** Replace one canonical Agent/provider rule; an empty exact list deletes it. */
      setAgentProviderAccess: (type: string, provider: string, models?: readonly string[]): void => {
        this.config.modelRouting = applyAgentProviderAccess(this.config.modelRouting, type, provider, models);
        this.persist("modelRouting");
      },
      configureAgentProviderAccess: (type: string, provider: string, models?: readonly string[]): void => {
        const next = applyQuickAgentProviderAccess(this.config.modelRouting, type, provider, models);
        // An invalid selection used to return before persist so a failed
        // picker could not leave a written routing/provider half-change.
        if (JSON.stringify(next) === JSON.stringify(this.config.modelRouting)) return;
        this.config.modelRouting = next;
        this.persist("modelRouting");
      },
      setParentModelAccess: (type: string, allowed: boolean): void => {
        this.config.modelRouting = applyParentModelAccess(this.config.modelRouting, type, allowed);
        this.persist("modelRouting");
      },
      setThinkingAccess: (
        type: string,
        modelKey: string,
        allowed: readonly ThinkingLevel[],
        defaultLevel: ThinkingLevel,
      ): void => {
        const next = applyThinkingAccess(this.config.modelRouting, type, modelKey, allowed, defaultLevel);
        if (JSON.stringify(next) === JSON.stringify(this.config.modelRouting)) return;
        this.config.modelRouting = next;
        this.persist("modelRouting");
      },
      resetThinkingAccess: (type: string, modelKey: string): void => {
        const next = applyResetThinkingAccess(this.config.modelRouting, type, modelKey);
        if (JSON.stringify(next) === JSON.stringify(this.config.modelRouting)) return;
        this.config.modelRouting = next;
        this.persist("modelRouting");
      },
      deleteProviderRules: (provider: string): void => {
        this.config.modelRouting = applyDeleteProviderRules(this.config.modelRouting, provider);
        this.persist("modelRouting");
      },
      cleanUnavailableModels: (provider: string, modelIds: readonly string[]): void => {
        this.config.modelRouting = applyCleanUnavailableModels(this.config.modelRouting, provider, modelIds);
        this.persist("modelRouting");
      },
      clearAll: (): void => {
        this.config.modelRouting = applyClearModelAccess();
        this.persist("modelRouting");
      },
    },
  };

  /**
   * Commit-first agent-fragment update (REQ-CONFIG-001): the candidate
   * fragment is persisted before it becomes the effective value, and the
   * navigator is only synchronized after a successful commit. Failure keeps
   * the previous value and reports an explicit message to the settings
   * workflow. Serves the display, spawn-options, and system-prompt pages
   * until their fragments move to owning capabilities.
   */
  updateAgentSetting<K extends keyof AgentSettings>(
    key: K,
    value: NonNullable<AgentSettings[K]>,
  ): { ok: true } | { ok: false; message: string } {
    const candidate = { ...this.config.agent, [key]: value };
    const assignments = JSON.parse(JSON.stringify(candidate)) as Record<string, JsonValue>;
    const result = this.io.commit("agent", assignments);
    if (!result.ok) return result;
    this.config.agent = candidate;
    this.syncStatsVisibility();
    return { ok: true };
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  /** Re-read the persisted document and re-sync deps. Called at session_start. */
  reload(): void {
    this.io.reload();
    this.config = this.loadFromSections();
    this.syncStatsVisibility();
  }

  /** Inject side-effect targets. Re-syncs whatever deps are present (lazy navigator). */
  setDeps(deps: ConfigStoreDeps): void {
    if (deps.navigator !== undefined) this.navigator = deps.navigator;
    this.syncStatsVisibility();
  }

  /** Drop deps at session_shutdown. The navigator is disposed by the composition root. */
  dispose(): void {
    this.navigator = undefined;
  }

  // ── Private helpers ────────────────────────────────────────────

  /** Resolve raw sections into a complete config with capability defaults. */
  private loadFromSections(): SubagentsConfig {
    const agentRaw = this.io.read("agent");
    const agentSource = isPlainObject(agentRaw) ? agentRaw : {};
    const agent: AgentSettings = {} as AgentSettings;
    for (const key of AGENT_SETTING_KEYS) {
      const value = agentSource[key];
      if (value !== undefined) (agent as unknown as Record<string, unknown>)[key] = value;
    }
    return {
      modelRouting: parseModelAccessFragment(this.io.read("modelRouting")),
      agent: { ...DEFAULT_AGENT, ...agent },
    };
  }

  /**
   * Commit one section's canonical content. Failure keeps the old persisted
   * value while this store's memory already advanced — the pre-correction
   * behavior the remaining menus rely on until their settings paths migrate.
   */
  private persist(section: ConfigSection): void {
    const value = section === "modelRouting" ? this.config.modelRouting : this.config.agent;
    const assignments = JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
    const result = this.io.commit(section, assignments);
    if (!result.ok) {
      console.error(`[subagents] Failed to save config: ${result.message}`);
    }
  }

  /** Push stats visibility into the navigator below the editor. */
  private syncStatsVisibility(): void {
    const navigator = this.navigator;
    if (!navigator) return;
    const a = this.agent;
    navigator.setStatsVisibility({
      showTools: a.showTools,
      showTurns: a.showTurns,
      showInput: a.showInput,
      showOutput: a.showOutput,
      showContext: a.showContext,
      showCost: a.showCost,
      showTime: a.showTime,
    });
  }
}
