/**
 * config-store.ts — Deep module owning persisted config + per-session overrides.
 *
 * Absorbs config-io.ts, config-mutator.ts, and the config-sync half of
 * state.ts. See docs/adr/0004-composition-root-over-shared-state.md.
 *
 * - Reads return defaults baked in (no `?? 6` at call sites).
 * - Each persisted mutate method is mutate + persist + its side effect, so a
 *   side effect cannot be forgotten.
 * - Navigator/manager are injected after construction (they're created lazily).
 *
 * Lifecycle: per-session. `reload()` re-reads disk + resets session overrides
 * at session_start. `dispose()` drops deps at session_shutdown.
 */

import type { ResolvedModelSelection } from "../models/model-precedence.js";
import { resolveModelSelection } from "../models/model-precedence.js";
import type { AgentNavigator } from "../ui/agent-navigator.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { SessionModelOverrides, SubagentsConfig } from "./types.js";
import type { SystemPromptMode } from "../agents/types.js";
import type { ThinkingLevel } from "../types.js";
import { parseModelKey } from "../utils.js";
import { VALID_SYSTEM_PROMPT_MODES, DEFAULT_CONCURRENCY, loadConfig, saveConfigAtomic } from "./config-io.js";


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
  /** Default thinking level for spawned agents. Undefined = inherit from agent config. */
  readonly defaultThinking: ThinkingLevel | undefined;
  /** Global default for skills loading: true (load all) or false (none). */
  readonly loadSkillsImplicitly: boolean;
  /** Global default for extensions loading: true (load all) or false (none). */
  readonly loadExtensionsImplicitly: boolean;
  /** Whether to skip built-in default agents at registration. */
  readonly disableDefaultAgents: boolean;
  /** Whether to show toolUses count in widget stats line. */
  readonly showTools: boolean;
  /** Whether to show turn count in widget stats line. */
  readonly showTurns: boolean;
  /** Whether to show input tokens in widget stats line. */
  readonly showInput: boolean;
  /** Whether to show output tokens in widget stats line. */
  readonly showOutput: boolean;
  /** Whether to show context percent and compactions in widget stats line. */
  readonly showContext: boolean;
  /** Whether to show elapsed time in widget stats line. */
  readonly showTime: boolean;
}

/** Resolved routing policy snapshot (copies, so callers cannot mutate the store). */
export interface ResolvedRoutingConfig {
  readonly enabled: boolean;
  readonly allowedProviders: string[];
  readonly agentModels: Record<string, string>;
}

/** Side-effect targets, injected after construction. */
export interface ConfigStoreDeps {
  navigator?: AgentNavigator;
  manager?: AgentManager;
}

export class ConfigStore {
  private config: SubagentsConfig;
  private sessionOverrides: SessionModelOverrides = {};
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
      defaultThinking: a.defaultThinking as ThinkingLevel | undefined,
      loadSkillsImplicitly: a.loadSkillsImplicitly !== false,
      loadExtensionsImplicitly: a.loadExtensionsImplicitly !== false,
      disableDefaultAgents: a.disableDefaultAgents === true,
      showTools: a.showTools !== false,
      showTurns: a.showTurns !== false,
      showInput: a.showInput !== false,
      showOutput: a.showOutput !== false,
      showContext: a.showContext !== false,
      showTime: a.showTime !== false,
    };
  }

  get routing(): ResolvedRoutingConfig {
    return {
      enabled: this.config.modelRouting.enabled,
      allowedProviders: [...this.config.modelRouting.allowedProviders],
      agentModels: { ...this.config.modelRouting.agentModels },
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

  /**
   * Session assignment for an agent type: string = model, null = explicit
   * session inherit, undefined = no session assignment.
   */
  sessionModelOverride(type: string): string | null | undefined {
    return this.sessionOverrides[type];
  }

  /** Copy of all session assignments (string or null), for UI enumeration. */
  sessionOverridesSnapshot(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const [type, model] of Object.entries(this.sessionOverrides)) {
      out[type] = model as string | null;
    }
    return out;
  }

  /**
   * Agent types whose assignment (persistent or session string) resolves to
   * the given provider. Used by the UI to list what a provider removal would
   * clear, including types no longer registered as agents.
   */
  assignmentTypesForProvider(provider: string): string[] {
    const types = new Set<string>();
    for (const [type, model] of Object.entries(this.config.modelRouting.agentModels)) {
      const parsed = parseModelKey(model);
      if (parsed?.provider === provider) types.add(type);
    }
    for (const [type, model] of Object.entries(this.sessionOverrides)) {
      if (model == null) continue;
      const parsed = parseModelKey(model);
      if (parsed?.provider === provider) types.add(type);
    }
    return [...types];
  }

  /**
   * Resolve the effective model candidate for a spawn. Precedence: session assignment →
   * persistent assignment → agentConfig (frontmatter) → parentModelId. The routing
   * switch is enforced by callers (tool execution / runner), not here.
   */
  modelSelectionFor(
    type: string,
    parentModelId: string,
    agentConfig?: { model?: string },
  ): ResolvedModelSelection {
    return resolveModelSelection({
      subagentType: type,
      agentConfig,
      config: this.config,
      parentModelId,
      sessionOverrides: this.sessionOverrides,
    });
  }

  // ── Mutations ──────────────────────────────────────────────────
  // Each persisted method = mutate + persist (+ side effect). Session methods
  // are in-memory only: never persisted, no side effects.

  readonly mutate = {
    routing: {
      setEnabled: (enabled: boolean): void => {
        this.config.modelRouting.enabled = enabled;
        this.persist();
      },
      /** Add/remove a single provider on the allowlist. Parent provider is never stored here. */
      setProviderAllowed: (provider: string, allowed: boolean): void => {
        const set = new Set(this.config.modelRouting.allowedProviders);
        if (allowed) {
          set.add(provider);
        } else {
          set.delete(provider);
        }
        this.config.modelRouting.allowedProviders = [...set];
        this.persist();
      },
      /**
       * Remove a provider from the allowlist and drop every assignment that
       * resolves to it — persistent and session — in one persisted step.
       */
      removeProvider: (provider: string): void => {
        this.config.modelRouting.allowedProviders =
          this.config.modelRouting.allowedProviders.filter((p) => p !== provider);
        this.config.modelRouting.agentModels = Object.fromEntries(
          Object.entries(this.config.modelRouting.agentModels).filter(([, model]) => {
            const parsed = parseModelKey(model);
            return !parsed || parsed.provider !== provider;
          }),
        );
        for (const [type, model] of Object.entries(this.sessionOverrides)) {
          if (model == null) continue;
          const parsed = parseModelKey(model);
          if (parsed?.provider === provider) delete this.sessionOverrides[type];
        }
        this.persist();
      },
      /**
       * Set (string) or clear (null) a persistent per-agent assignment.
       * A permanent choice supersedes any session override for the same type;
       * a clear restores parent inheritance for both layers.
       */
      setAgentModel: (type: string, model: string | null): void => {
        if (model === null || model === "") {
          delete this.config.modelRouting.agentModels[type];
        } else {
          this.config.modelRouting.agentModels[type] = model;
        }
        delete this.sessionOverrides[type];
        this.persist();
      },
      /** Clear allowlist, assignments (persistent + session), and disable routing. */
      clearAll: (): void => {
        this.config.modelRouting = { enabled: false, allowedProviders: [], agentModels: {} };
        this.sessionOverrides = {};
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
      setDefaultThinking: (level: ThinkingLevel | undefined): void => {
        if (level === undefined) {
          delete this.config.agent.defaultThinking;
        } else {
          this.config.agent.defaultThinking = level;
        }
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
    session: {
      /**
       * Set a session-only assignment for an agent type. Null = explicitly
       * inherit the parent for this session. Not persisted.
       */
      setOverride: (type: string, model: string | null): void => {
        this.sessionOverrides[type] = model;
      },
      clearAll: (): void => {
        this.sessionOverrides = {};
      },
    },
  };

  // ── Lifecycle ──────────────────────────────────────────────────

  /** Re-read disk, reset session assignments, re-sync deps. Called at session_start. */
  reload(): void {
    this.config = this.io.load();
    this.sessionOverrides = {};
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
