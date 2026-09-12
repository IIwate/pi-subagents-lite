/**
 * config-store.ts — Deep module owning persisted configuration.
 *
 * - Reads return defaults baked in (no `?? 6` at call sites).
 * - Each persisted mutate method is prepare + persist + publish + its side effect, so a
 *   side effect cannot be forgotten.
 * - Navigator/engine are injected after construction (they're created lazily).
 *
 * Lifecycle: per-session. `reload()` re-reads disk at session_start;
 * `dispose()` drops deps at session_shutdown.
 */

import type { AgentNavigator } from "../ui/agent-navigator.js";
import type { TaskEngine } from "../engine/task-engine.js";
import type { AgentCatalogue } from "../agents/agent-types.js";
import type { AgentModelAccess, ProviderModelAccess, SubagentsConfig } from "./types.js";
import type { SystemPromptMode } from "../agents/types.js";
import type { ThinkingLevel } from "../types.js";
import { VALID_SYSTEM_PROMPT_MODES, DEFAULT_CONCURRENCY, loadConfig, saveConfigAtomic, normalizeConcurrencyLimit, validateGraceTurns } from "./config-io.js";

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

/** Injected persistence adapter. Swap for an in-memory adapter in tests. */
// Note: see .agents/notes/implemented/bug-fix/2026-09-10-configuration-commit-and-validation.md
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
  /** Default thinking level for spawned agents. Undefined = inherit from agent config. */
  readonly defaultThinking: ThinkingLevel | undefined;
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
  engine?: Pick<TaskEngine, "setLimits">;
  catalogue?: Pick<AgentCatalogue, "setDefaultAgentsDisabled">;
}

// Note: see .agents/notes/implemented/architecture/2026-09-10-configuration-ownership-and-persistence.md
export class ConfigStore {
  private config: SubagentsConfig;
  private navigator?: AgentNavigator;
  private engine?: Pick<TaskEngine, "setLimits">;
  private catalogue?: Pick<AgentCatalogue, "setDefaultAgentsDisabled">;
  private disposed = false;

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
      defaultThinking: a.defaultThinking as ThinkingLevel | undefined,
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
      setOwn(agentAccess, type, { providers });
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

  /** Agent types with a saved rule for one provider, including unavailable types. */
  accessTypesForProvider(provider: string): string[] {
    return Object.entries(this.config.modelRouting.agentAccess)
      .filter(([, access]) => Object.hasOwn(access.providers, provider))
      .map(([type]) => type)
      .sort();
  }

  // ── Mutations ──────────────────────────────────────────────────
  // Publish candidates only after persistence succeeds.

  readonly mutate = {
    routing: {
      setEnabled: (enabled: boolean): void => {
        this.commit(config => { config.modelRouting.enabled = enabled; });
      },
      /** Pause or restore one provider without touching dormant agent rules. */
      setProviderEnabled: (provider: string, enabled: boolean): void => {
        const key = provider.trim();
        if (!key) return;
        this.commit(config => {
          const providers = new Set(config.modelRouting.enabledProviders);
          if (enabled) providers.add(key); else providers.delete(key);
          config.modelRouting.enabledProviders = [...providers];
        });
      },
      /** Replace one canonical Agent/provider rule; an empty exact list deletes it. */
      setAgentProviderAccess: (type: string, provider: string, models?: readonly string[]): void => {
        this.commit(config => this.writeAgentProviderAccess(config, type, provider, models));
      },
      /** Quick setup: enable routing/provider and write the same canonical rule once. */
      configureAgentProviderAccess: (type: string, provider: string, models?: readonly string[]): void => {
        const key = provider.trim();
        if (!key) return;
        this.commit(config => {
          config.modelRouting.enabled = true;
          config.modelRouting.enabledProviders = [...new Set([
            ...config.modelRouting.enabledProviders,
            key,
          ])];
          this.writeAgentProviderAccess(config, type, key, models);
        });
      },
      /** Remove one provider rule from every agent, including unavailable agent types. */
      deleteProviderRules: (provider: string): void => {
        this.commit(config => {
          for (const type of Object.keys(config.modelRouting.agentAccess)) {
            delete config.modelRouting.agentAccess[type].providers[provider];
            this.pruneAgentAccess(config, type);
          }
        });
      },
      /** Remove exact unavailable IDs only; all-model rules are untouched. */
      cleanUnavailableModels: (modelsByProvider: ReadonlyMap<string, ReadonlySet<string>>): void => {
        this.commit(config => {
          for (const [provider, stale] of modelsByProvider) {
            for (const type of Object.keys(config.modelRouting.agentAccess)) {
              const rule = ownValue(config.modelRouting.agentAccess[type].providers, provider);
              if (!rule?.models) continue;
              rule.models = rule.models.filter((modelId) => !stale.has(modelId));
              if (rule.models.length === 0) delete config.modelRouting.agentAccess[type].providers[provider];
              this.pruneAgentAccess(config, type);
            }
          }
        });
      },
      clearAll: (): void => {
        this.commit(config => { config.modelRouting = { enabled: false, enabledProviders: [], agentAccess: {} }; });
      },
    },
    agent: {
      setForceBackground: (enabled: boolean): void => {
        this.commit(config => { config.agent.forceBackground = enabled; });
      },
      setShowCost: (enabled: boolean): void => {
        this.commit(config => { config.agent.showCost = enabled; });
        this.syncStatsVisibility();
      },
      setGraceTurns: (n: number): void => {
        this.commit(config => { config.agent.graceTurns = validateGraceTurns(n); });
      },
      setSystemPromptMode: (mode: SystemPromptMode): void => {
        this.commit(config => { config.agent.systemPromptMode = mode; });
      },
      setIncludeContextFiles: (enabled: boolean): void => {
        this.commit(config => { config.agent.includeContextFiles = enabled; });
      },
      setDefaultThinking: (level: ThinkingLevel | undefined): void => {
        this.commit(config => {
          if (level === undefined) {
            delete config.agent.defaultThinking;
          } else {
            config.agent.defaultThinking = level;
          }
        });
      },
      setLoadSkillsImplicitly: (value: boolean): void => {
        this.commit(config => { config.agent.loadSkillsImplicitly = value; });
      },
      setLoadExtensionsImplicitly: (value: boolean): void => {
        this.commit(config => { config.agent.loadExtensionsImplicitly = value; });
      },
      setDisableDefaultAgents: (value: boolean): void => {
        this.commit(config => { config.agent.disableDefaultAgents = value; });
        this.catalogue?.setDefaultAgentsDisabled(value);
      },
      setExpandListByDefault: (value: boolean): void => {
        this.commit(config => { config.agent.expandListByDefault = value; });
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
        this.commit(config => { config.concurrency.default = normalizeConcurrencyLimit(n); });
        this.applyConcurrency();
      },
      setProvider: (key: string, n: number): void => {
        this.commit(config => {
          config.concurrency.providers = { ...(config.concurrency.providers ?? {}), [key]: normalizeConcurrencyLimit(n) };
        });
        this.applyConcurrency();
      },
      setModel: (key: string, n: number): void => {
        this.commit(config => {
          config.concurrency.models = { ...(config.concurrency.models ?? {}), [key]: normalizeConcurrencyLimit(n) };
        });
        this.applyConcurrency();
      },
      removeProvider: (key: string): void => {
        this.commit(config => {
          if (config.concurrency.providers) delete config.concurrency.providers[key];
        });
        this.applyConcurrency();
      },
      removeModel: (key: string): void => {
        this.commit(config => {
          if (config.concurrency.models) delete config.concurrency.models[key];
        });
        this.applyConcurrency();
      },
      reset: (): void => {
        this.commit(config => { config.concurrency = { ...DEFAULT_CONCURRENCY }; });
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

  /** Inject side-effect targets. Re-syncs whatever deps are present (lazy navigator/engine). */
  setDeps(deps: ConfigStoreDeps): void {
    if (deps.navigator !== undefined) this.navigator = deps.navigator;
    if (deps.engine !== undefined) this.engine = deps.engine;
    if (deps.catalogue !== undefined) this.catalogue = deps.catalogue;
    this.syncAllDeps();
  }

  /** Drop deps at session_shutdown. The navigator/engine are disposed by the composition root. */
  dispose(): void {
    this.navigator = undefined;
    this.disposed = true;
    this.engine = undefined;
    this.catalogue = undefined;
  }

  // ── Private helpers ────────────────────────────────────────────

  private commit(update: (candidate: SubagentsConfig) => void): void {
    if (this.disposed) throw new Error("Configuration belongs to a closed runtime");
    const candidate = structuredClone(this.config);
    update(candidate);
    this.io.save(candidate);
    this.config = candidate;
  }

  private writeAgentProviderAccess(config: SubagentsConfig, type: string, provider: string, models?: readonly string[]): void {
    const typeKey = type.trim();
    const providerKey = provider.trim();
    if (!typeKey || !providerKey) return;
    const normalized = models === undefined
      ? undefined
      : [...new Set(models.map((model) => model.trim()).filter(Boolean))];
    const existing = ownValue(config.modelRouting.agentAccess, typeKey);
    if (normalized?.length === 0) {
      if (existing) delete existing.providers[providerKey];
      this.pruneAgentAccess(config, typeKey);
      return;
    }
    const agent = existing ?? { providers: {} };
    if (!existing) setOwn(config.modelRouting.agentAccess, typeKey, agent);
    setOwn(agent.providers, providerKey, normalized ? { models: normalized } : {});
  }

  private pruneAgentAccess(config: SubagentsConfig, type: string): void {
    const access = ownValue(config.modelRouting.agentAccess, type);
    if (access && Object.keys(access.providers).length === 0) {
      delete config.modelRouting.agentAccess[type];
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

  /** Publish a stats visibility flag before synchronizing the navigator. */
  private setAgentVisibility(key: "showTools" | "showTurns" | "showInput" | "showOutput" | "showContext" | "showTime", value: boolean): void {
    this.commit(config => { config.agent[key] = value; });
    this.syncStatsVisibility();
  }

  private applyConcurrency(): void {
    this.engine?.setLimits(this.config.concurrency);
  }

  /** Full re-sync of all present deps. Used by reload/setDeps. */
  private syncAllDeps(): void {
    this.syncStatsVisibility();
    this.applyConcurrency();
    this.catalogue?.setDefaultAgentsDisabled(this.agent.disableDefaultAgents);
  }
}
