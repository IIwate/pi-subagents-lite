/**
 * config-store.ts — Deep module owning persisted configuration.
 *
 * Absorbs config-io.ts, config-mutator.ts, and the config-sync half of
 * state.ts. See docs/adr/0004-composition-root-over-shared-state.md.
 *
 * - Reads return defaults baked in (no `?? 6` at call sites).
 * - Each persisted mutate method is mutate + persist + its side effect, so a
 *   side effect cannot be forgotten.
 * - Navigator/manager are injected after construction (they're created lazily).
 *
 * Lifecycle: per-session. `reload()` re-reads disk at session_start;
 * `dispose()` drops deps at session_shutdown.
 */

import type { AgentNavigator } from "../ui/agent-navigator.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { AgentModelAccess, ProviderModelAccess, SubagentsConfig, ThinkingAccessOverride } from "./types.js";
import { CANONICAL_THINKING_LEVELS } from "./types.js";
import {
  applyAgentProviderAccess,
  applyParentModelAccess,
  applyQuickAgentProviderAccess,
} from "../modules/model-access/public.js";
import type { SystemPromptMode } from "../agents/types.js";
import type { ThinkingLevel } from "../types.js";
import { VALID_SYSTEM_PROMPT_MODES, DEFAULT_CONCURRENCY, loadConfig, saveConfigAtomic } from "./config-io.js";

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

/** Injected persistence adapter. Swap for an in-memory adapter in tests. */
export interface ConfigIO {
  load(): SubagentsConfig;
  save(config: SubagentsConfig): void;
}

/** Production adapter wrapping the real config file. */
export const fileConfigIO: ConfigIO = {
  load: () => loadConfig(),
  save: (c) => saveConfigAtomic(c),
};

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
  navigator?: AgentNavigator;
  manager?: AgentManager;
}

export class ConfigStore {
  private config: SubagentsConfig;
  private navigator?: AgentNavigator;
  private manager?: AgentManager;

  constructor(private readonly io: ConfigIO = fileConfigIO) {
    this.config = this.io.load();
  }

  // ── Reads ──────────────────────────────────────────────────────

  get agent(): ResolvedAgentSettings {
    const a = this.config.agent;

    return {
      forceBackground: a.forceBackground === true,
      showCost: a.showCost === true,
      graceTurns: a.graceTurns ?? 6,
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
    const prefix = `${provider}/`;
    return Object.entries(this.config.modelRouting.agentAccess)
      .filter(([, access]) =>
        Object.hasOwn(access.providers, provider)
        || Object.keys(access.thinking ?? {}).some((key) => key.startsWith(prefix)),
      )
      .map(([type]) => type)
      .sort();
  }

  // ── Mutations ──────────────────────────────────────────────────
  // Each persisted method = mutate + persist (+ side effect).

  readonly mutate = {
    routing: {
      setEnabled: (enabled: boolean): void => {
        this.config.modelRouting.enabled = enabled;
        this.persist();
      },
      /** Pause or restore one provider without touching dormant agent rules. */
      setProviderEnabled: (provider: string, enabled: boolean): void => {
        const key = provider.trim();
        if (!key) return;
        const providers = new Set(this.config.modelRouting.enabledProviders);
        if (enabled) providers.add(key); else providers.delete(key);
        this.config.modelRouting.enabledProviders = [...providers];
        this.persist();
      },
      /** Replace one canonical Agent/provider rule; an empty exact list deletes it. */
      setAgentProviderAccess: (type: string, provider: string, models?: readonly string[]): void => {
        this.config.modelRouting = applyAgentProviderAccess(this.config.modelRouting, type, provider, models);
        this.persist();
      },
      configureAgentProviderAccess: (type: string, provider: string, models?: readonly string[]): void => {
        const next = applyQuickAgentProviderAccess(this.config.modelRouting, type, provider, models);
        // An invalid selection used to return before persist so a failed
        // picker could not leave a written routing/provider half-change.
        if (JSON.stringify(next) === JSON.stringify(this.config.modelRouting)) return;
        this.config.modelRouting = next;
        this.persist();
      },
      setParentModelAccess: (type: string, allowed: boolean): void => {
        this.config.modelRouting = applyParentModelAccess(this.config.modelRouting, type, allowed);
        this.persist();
      },
      setThinkingAccess: (
        type: string,
        modelKey: string,
        allowed: readonly ThinkingLevel[],
        defaultLevel: ThinkingLevel,
      ): void => {
        const typeKey = type.trim();
        const key = modelKey.trim();
        const slash = key.indexOf("/");
        const validLevels = new Set<string>(CANONICAL_THINKING_LEVELS);
        const normalized = [...new Set(allowed.filter((level) => validLevels.has(level)))];
        if (!typeKey || slash <= 0 || slash === key.length - 1 || normalized.length === 0 || !normalized.includes(defaultLevel)) return;
        const access = ownValue(this.config.modelRouting.agentAccess, typeKey) ?? { providers: {} };
        if (!Object.hasOwn(this.config.modelRouting.agentAccess, typeKey)) {
          setOwn(this.config.modelRouting.agentAccess, typeKey, access);
        }
        const thinking = access.thinking ?? {};
        if (!access.thinking) access.thinking = thinking;
        setOwn(thinking, key, { allowed: normalized, default: defaultLevel });
        this.persist();
      },
      resetThinkingAccess: (type: string, modelKey: string): void => {
        const typeKey = type.trim();
        const key = modelKey.trim();
        const access = ownValue(this.config.modelRouting.agentAccess, typeKey);
        if (!access?.thinking || !Object.hasOwn(access.thinking, key)) return;
        delete access.thinking[key];
        if (Object.keys(access.thinking).length === 0) delete access.thinking;
        this.pruneAgentAccess(typeKey);
        this.persist();
      },
      /** Remove one provider's access and Thinking policy from every agent type. */
      deleteProviderRules: (provider: string): void => {
        for (const type of Object.keys(this.config.modelRouting.agentAccess)) {
          const access = this.config.modelRouting.agentAccess[type];
          delete access.providers[provider];
          for (const key of Object.keys(access.thinking ?? {})) {
            if (key.startsWith(`${provider}/`)) delete access.thinking![key];
          }
          if (access.thinking && Object.keys(access.thinking).length === 0) delete access.thinking;
          this.pruneAgentAccess(type);
        }
        this.persist();
      },
      /** Remove exact unavailable IDs only; all-model rules and unrelated Thinking overrides are untouched. */
      cleanUnavailableModels: (provider: string, modelIds: readonly string[]): void => {
        const stale = new Set(modelIds);
        for (const type of Object.keys(this.config.modelRouting.agentAccess)) {
          const access = this.config.modelRouting.agentAccess[type];
          const rule = ownValue(access.providers, provider);
          if (!rule?.models) continue;
          const removed = rule.models.filter((modelId) => stale.has(modelId));
          if (removed.length === 0) continue;
          rule.models = rule.models.filter((modelId) => !stale.has(modelId));
          if (rule.models.length === 0) delete access.providers[provider];
          for (const modelId of removed) delete access.thinking?.[`${provider}/${modelId}`];
          if (access.thinking && Object.keys(access.thinking).length === 0) delete access.thinking;
          this.pruneAgentAccess(type);
        }
        this.persist();
      },
      clearAll: (): void => {
        this.config.modelRouting = { enabled: false, enabledProviders: [], agentAccess: {} };
        this.persist();
      },
    },
    agent: {
      setForceBackground: (enabled: boolean): void => {
        this.config.agent.forceBackground = enabled;
        this.persist();
      },
      setShowCost: (enabled: boolean): void => {
        this.config.agent.showCost = enabled;
        this.persist();
        this.syncStatsVisibility();
      },
      setGraceTurns: (n: number): void => {
        this.config.agent.graceTurns = n;
        this.persist();
      },
      setSystemPromptMode: (mode: SystemPromptMode): void => {
        this.config.agent.systemPromptMode = mode;
        this.persist();
      },
      setIncludeContextFiles: (enabled: boolean): void => {
        this.config.agent.includeContextFiles = enabled;
        this.persist();
      },
      setLoadSkillsImplicitly: (value: boolean): void => {
        this.config.agent.loadSkillsImplicitly = value;
        this.persist();
      },
      setLoadExtensionsImplicitly: (value: boolean): void => {
        this.config.agent.loadExtensionsImplicitly = value;
        this.persist();
      },
      setDisableDefaultAgents: (value: boolean): void => {
        this.config.agent.disableDefaultAgents = value;
        this.persist();
      },
      setExpandListByDefault: (value: boolean): void => {
        this.config.agent.expandListByDefault = value;
        this.persist();
      },
      setShowTools: (enabled: boolean) => this.setAgentVisibility("showTools", enabled),
      setShowTurns: (enabled: boolean) => this.setAgentVisibility("showTurns", enabled),
      setShowInput: (enabled: boolean) => this.setAgentVisibility("showInput", enabled),
      setShowOutput: (enabled: boolean) => this.setAgentVisibility("showOutput", enabled),
      setShowContext: (enabled: boolean) => this.setAgentVisibility("showContext", enabled),
      setShowTime: (enabled: boolean) => this.setAgentVisibility("showTime", enabled),
    },
    concurrency: {
      setDefault: (n: number): void => {
        this.config.concurrency.default = n;
        this.persist();
        this.applyConcurrency();
      },
      setProvider: (key: string, n: number): void => {
        this.config.concurrency.providers = { ...(this.config.concurrency.providers ?? {}), [key]: n };
        this.persist();
        this.applyConcurrency();
      },
      setModel: (key: string, n: number): void => {
        this.config.concurrency.models = { ...(this.config.concurrency.models ?? {}), [key]: n };
        this.persist();
        this.applyConcurrency();
      },
      removeProvider: (key: string): void => {
        if (this.config.concurrency.providers) delete this.config.concurrency.providers[key];
        this.persist();
        this.applyConcurrency();
      },
      removeModel: (key: string): void => {
        if (this.config.concurrency.models) delete this.config.concurrency.models[key];
        this.persist();
        this.applyConcurrency();
      },
      reset: (): void => {
        this.config.concurrency = { ...DEFAULT_CONCURRENCY };
        this.persist();
        this.applyConcurrency();
      },
    },
  };

  // ── Lifecycle ──────────────────────────────────────────────────

  /** Re-read disk and re-sync deps. Called at session_start. */
  reload(): void {
    this.config = this.io.load();
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

  private persist(): void {
    this.io.save(this.config);
  }

  private pruneAgentAccess(type: string): void {
    const access = ownValue(this.config.modelRouting.agentAccess, type);
    if (
      access
      && Object.keys(access.providers).length === 0
      && access.parentModelAccess === undefined
      && Object.keys(access.thinking ?? {}).length === 0
    ) {
      delete this.config.modelRouting.agentAccess[type];
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

  /** Update a stats visibility flag: mutate config → persist → sync navigator. */
  private setAgentVisibility(key: "showTools" | "showTurns" | "showInput" | "showOutput" | "showContext" | "showTime", value: boolean): void {
    this.config.agent[key] = value;
    this.persist();
    this.syncStatsVisibility();
  }

  private applyConcurrency(): void {
    this.manager?.setConcurrency(this.config.concurrency);
  }

  /** Full re-sync of all present deps. Used by reload/setDeps. */
  private syncAllDeps(): void {
    this.syncStatsVisibility();
    this.applyConcurrency();
  }
}
