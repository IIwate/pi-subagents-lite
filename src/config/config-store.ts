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
import type { SubagentRuntime } from "../modules/subagent-runtime/public.js";
import type {
  Configuration,
  JsonValue,
} from "../modules/configuration/public.js";
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

/** Default concurrency config — used for resets. */
export const DEFAULT_CONCURRENCY: SubagentsConfig["concurrency"] = { default: 4 };

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

type ConfigSection = "modelRouting" | "agent" | "concurrency";

/** Section-level document access, backed by the configuration module. */
export interface ConfigSectionIO {
  reload(): void;
  read(section: ConfigSection): unknown;
  commit(section: ConfigSection, assignments: Record<string, JsonValue>): { ok: true } | { ok: false; message: string };
}

/** Production adapter over the one configuration facade. */
export function createConfigurationSectionIO(configuration: Configuration): ConfigSectionIO {
  // The store is the only writer while menus migrate, so tracking the last
  // observed revision is enough to satisfy optimistic concurrency.
  let revision = 0;
  return {
    reload() {
      const result = configuration.execute({ kind: "reload" });
      if (result.ok) revision = result.revision;
    },
    read(section) {
      const result = configuration.execute({ kind: "read-value", path: [section] });
      if (!result.ok) return undefined;
      revision = result.revision;
      return "found" in result && result.found ? result.value : undefined;
    },
    commit(section, assignments) {
      const result = configuration.execute({
        kind: "commit-fragment",
        expectedRevision: revision,
        section,
        assignments,
      });
      if (!result.ok) return { ok: false, message: result.error.message };
      revision = result.revision;
      return { ok: true };
    },
  };
}

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
  manager?: SubagentRuntime;
}

export class ConfigStore {
  private config: SubagentsConfig;
  private navigator?: ChildScreenHost;
  private manager?: SubagentRuntime;

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

  get concurrency(): {
    default: number;
    providers: Record<string, number>;
    models: Record<string, number>;
  } {
    return {
      default: this.config.concurrency.default,
      providers: this.config.concurrency.providers ?? {},
      models: this.config.concurrency.models ?? {},
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
    agent: {
      setForceBackground: (enabled: boolean): void => {
        this.config.agent.forceBackground = enabled;
        this.persist("agent");
      },
      setShowCost: (enabled: boolean): void => {
        this.updateDisplaySetting("showCost", enabled);
      },
      setGraceTurns: (n: number): void => {
        this.config.agent.graceTurns = n;
        this.persist("agent");
      },
      setSystemPromptMode: (mode: SystemPromptMode): void => {
        this.config.agent.systemPromptMode = mode;
        this.persist("agent");
      },
      setIncludeContextFiles: (enabled: boolean): void => {
        this.config.agent.includeContextFiles = enabled;
        this.persist("agent");
      },
      setLoadSkillsImplicitly: (value: boolean): void => {
        this.config.agent.loadSkillsImplicitly = value;
        this.persist("agent");
      },
      setLoadExtensionsImplicitly: (value: boolean): void => {
        this.config.agent.loadExtensionsImplicitly = value;
        this.persist("agent");
      },
      setDisableDefaultAgents: (value: boolean): void => {
        this.config.agent.disableDefaultAgents = value;
        this.persist("agent");
      },
      setExpandListByDefault: (value: boolean): void => {
        this.updateDisplaySetting("expandListByDefault", value);
      },
      setShowTools: (enabled: boolean) => { this.updateDisplaySetting("showTools", enabled); },
      setShowTurns: (enabled: boolean) => { this.updateDisplaySetting("showTurns", enabled); },
      setShowInput: (enabled: boolean) => { this.updateDisplaySetting("showInput", enabled); },
      setShowOutput: (enabled: boolean) => { this.updateDisplaySetting("showOutput", enabled); },
      setShowContext: (enabled: boolean) => { this.updateDisplaySetting("showContext", enabled); },
      setShowTime: (enabled: boolean) => { this.updateDisplaySetting("showTime", enabled); },
    },
    concurrency: {
      setDefault: (n: number): void => {
        this.config.concurrency.default = n;
        this.persist("concurrency");
        this.applyConcurrency();
      },
      setProvider: (key: string, n: number): void => {
        this.config.concurrency.providers = { ...(this.config.concurrency.providers ?? {}), [key]: n };
        this.persist("concurrency");
        this.applyConcurrency();
      },
      setModel: (key: string, n: number): void => {
        this.config.concurrency.models = { ...(this.config.concurrency.models ?? {}), [key]: n };
        this.persist("concurrency");
        this.applyConcurrency();
      },
      removeProvider: (key: string): void => {
        if (this.config.concurrency.providers) delete this.config.concurrency.providers[key];
        this.persist("concurrency");
        this.applyConcurrency();
      },
      removeModel: (key: string): void => {
        if (this.config.concurrency.models) delete this.config.concurrency.models[key];
        this.persist("concurrency");
        this.applyConcurrency();
      },
      reset: (): void => {
        this.config.concurrency = { ...DEFAULT_CONCURRENCY };
        this.persist("concurrency");
        this.applyConcurrency();
      },
    },
  };

  /**
   * Commit-first display update (REQ-CONFIG-001): the candidate fragment is
   * persisted before it becomes the effective value, and the navigator is
   * only synchronized after a successful commit. Failure keeps the previous
   * value and reports an explicit message to the settings workflow.
   */
  updateDisplaySetting(
    key: "expandListByDefault" | "showTools" | "showTurns" | "showInput" | "showOutput" | "showContext" | "showCost" | "showTime",
    value: boolean,
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
    this.syncAllDeps();
  }

  /** Inject side-effect targets. Re-syncs whatever deps are present (lazy navigator/manager). */
  setDeps(deps: ConfigStoreDeps): void {
    if (deps.navigator !== undefined) this.navigator = deps.navigator;
    if (deps.manager !== undefined) this.manager = deps.manager;
    this.syncAllDeps();
  }

  /** Drop deps at session_shutdown. The navigator/manager are disposed by the composition root. */
  dispose(): void {
    this.navigator = undefined;
    this.manager = undefined;
  }

  // ── Private helpers ────────────────────────────────────────────

  /** Resolve raw sections into a complete config with capability defaults. */
  private loadFromSections(): SubagentsConfig {
    const agentRaw = this.io.read("agent");
    const concurrencyRaw = this.io.read("concurrency");
    const agentSource = isPlainObject(agentRaw) ? agentRaw : {};
    const concurrencySource = isPlainObject(concurrencyRaw) ? concurrencyRaw : {};
    const agent: AgentSettings = {} as AgentSettings;
    for (const key of AGENT_SETTING_KEYS) {
      const value = agentSource[key];
      if (value !== undefined) (agent as unknown as Record<string, unknown>)[key] = value;
    }
    return {
      modelRouting: parseModelAccessFragment(this.io.read("modelRouting")),
      agent: { ...DEFAULT_AGENT, ...agent },
      concurrency: {
        ...concurrencySource,
        default: typeof concurrencySource.default === "number" ? concurrencySource.default : DEFAULT_CONCURRENCY.default,
      } as SubagentsConfig["concurrency"],
    };
  }

  /**
   * Commit one section's canonical content. Failure keeps the old persisted
   * value while this store's memory already advanced — the pre-correction
   * behavior the remaining menus rely on until their settings paths migrate.
   */
  private persist(section: ConfigSection): void {
    const value = section === "modelRouting"
      ? this.config.modelRouting
      : section === "agent" ? this.config.agent : this.config.concurrency;
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

  private applyConcurrency(): void {
    this.manager?.replaceLimits({
      defaultModelLimit: Math.max(1, this.config.concurrency.default),
      modelLimits: Object.fromEntries(
        Object.entries(this.config.concurrency.models ?? {}).map(([key, limit]) => [key, Math.max(1, limit)]),
      ),
      providerLimits: Object.fromEntries(
        Object.entries(this.config.concurrency.providers ?? {}).map(([key, limit]) => [key, Math.max(1, limit)]),
      ),
    });
  }

  /** Full re-sync of all present deps. Used by reload/setDeps. */
  private syncAllDeps(): void {
    this.syncStatsVisibility();
    this.applyConcurrency();
  }
}
