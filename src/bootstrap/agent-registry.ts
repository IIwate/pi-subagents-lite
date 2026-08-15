/**
 * agent-registry.ts — The activation's live Agent type registry.
 *
 * The catalogue module owns discovery, parsing, and merge precedence. What it
 * cannot own is the set of types currently answerable, because that set changes
 * after the initial scan: the parent may name a type added to disk mid-session,
 * and the default-agent toggle must take effect for future calls without
 * disturbing accepted work. Those transitions are session state, so they live
 * in one registry created per ExtensionRuntime and handed a catalogue instance.
 *
 * Reads return the registered definition as-is; every accepted-call projection
 * goes through the catalogue's policy resolver so the definition shape crossing
 * that boundary is the module's, not this file's.
 */

import { DEFAULT_AGENTS } from "./default-agents.js";
import { BUILTIN_TOOL_NAMES } from "../platform/pi/agent-types.js";
import type { SystemPromptMode } from "../modules/prompt/public.js";
import {
  resolveAgentDefinitionPolicy,
  resolveAgentTypeName,
  type AgentCatalogue,
  type AgentDefinitionSnapshot,
  type AgentTypeResolution,
  type ResolvedAgentLoadingPolicy,
} from "../modules/agent-catalogue/public.js";

/** Session-facing definition: the catalogue snapshot, with built-in source omitted. */
export type AgentConfig = AgentDefinitionSnapshot;

/** Options for registering a freshly discovered catalogue. */
export interface RegisterAgentsOptions {
  /** When true, skip built-in DEFAULT_AGENTS. */
  disableDefaultAgents?: boolean;
}

/** Resolved config shape returned by resolvedConfig. */
export interface ResolvedAgentConfig {
  displayName: string;
  description: string;
  registeredTools: string[];
  /** Controls tool schema visibility. true = all, string[] = listed, false = none. */
  tools?: true | string[] | false;
  extensions: true | string[] | false;
  skills: true | string[] | false;
}

/**
 * The catalogue's resolved policy plus the session defaults the accepted-run
 * parser expects. Named here because it is what crosses back to the tool seam;
 * the fields themselves stay owned by the two modules that define them.
 */
export type AgentPolicyInputs = ResolvedAgentLoadingPolicy & {
  systemPromptMode: SystemPromptMode;
  includeContextFiles: boolean;
  parentModelKey: string;
};

/** Session-level defaults folded into one call's policy inputs. */
export interface AgentPolicyDefaults {
  loadSkillsImplicitly: boolean;
  loadExtensionsImplicitly: boolean;
  systemPromptMode: SystemPromptMode;
  includeContextFiles: boolean;
  parentModelKey: string;
}

/** Outcome of an on-demand scan for types added during the session. */
export type DiscoverAgentsResult =
  | { ok: true; added: number }
  | { ok: false; message: string };

/** The scan roots on-demand discovery reuses; project root is absent in untrusted sessions. */
export interface AgentScanRoots {
  globalDirectory: string;
  projectDirectory?: string;
}

export interface AgentRegistry {
  /** Replace the registry with a discovered catalogue. */
  register(userAgents: Map<string, AgentConfig>, options?: RegisterAgentsOptions): void;
  /** Record the authorized roots and default-agent policy used by on-demand discovery. */
  setScanRoots(roots: AgentScanRoots, disableDefaultAgents?: boolean): void;
  /** Apply the default-agent policy to future lookups without stopping accepted work. */
  setDefaultAgentsDisabled(disabled: boolean): void;
  /** Scan the known roots for types not yet registered. */
  discoverNew(worktreeDir?: string): Promise<DiscoverAgentsResult>;
  /**
   * Resolve a queried type name deterministically (REQ-AGENT-004). The truth
   * table lives in the catalogue core; the registry only supplies its current
   * entries snapshot.
   */
  resolveType(name: string): AgentTypeResolution;
  /** The registered definition for a type, or undefined. */
  agentConfig(name: string): AgentConfig | undefined;
  /** Visible type names, for spawning and guidance. */
  availableTypes(): string[];
  /** Every type name including hidden ones, for settings listings. */
  allTypes(): string[];
  /** Deep-copied policy inputs for an accepted call. */
  policyInputs(type: string, defaults: AgentPolicyDefaults): AgentPolicyInputs | undefined;
  /** Effective config for display and session configuration. */
  resolvedConfig(
    type: string,
    loadSkillsImplicitly?: boolean,
    loadExtensionsImplicitly?: boolean,
  ): ResolvedAgentConfig;
}

/** Built-ins have no source; every merged global/project definition has one. */
function isBuiltinDefault(name: string, config: AgentConfig): boolean {
  return DEFAULT_AGENTS.has(name) && config.source === undefined;
}

function toAgentConfig(definition: AgentDefinitionSnapshot): AgentConfig {
  const { source, ...config } = structuredClone(definition);
  return source === "built-in" ? config : { ...config, source };
}

function loadingPolicyFor(
  config: AgentConfig,
  loadSkillsImplicitly: boolean,
  loadExtensionsImplicitly: boolean,
) {
  return resolveAgentDefinitionPolicy({
    kind: "resolve-policy",
    // The registry still holds optional undefined properties from the file
    // parser. Canonicalize once here so the accepted boundary receives JSON,
    // while direct callers with functions or custom serializers stay rejected.
    definition: JSON.parse(JSON.stringify(config)),
    configuration: {
      loadSkillsImplicitly,
      loadExtensionsImplicitly,
      defaultRegisteredTools: [...BUILTIN_TOOL_NAMES],
    },
  });
}

export function createAgentRegistry(options: { catalogue: AgentCatalogue }): AgentRegistry {
  const agents = new Map<string, AgentConfig>();
  let scanRoots: AgentScanRoots = { globalDirectory: "" };
  let defaultAgentsDisabled = false;

  const resolveType = (name: string): AgentTypeResolution => resolveAgentTypeName({
    name,
    entries: [...agents.entries()].map(([key, config]) => ({
      name: key,
      ...(config.displayName !== undefined ? { displayName: config.displayName } : {}),
    })),
  });

  // Internal reads take a value only from a resolved outcome; ambiguity is a
  // caller-facing verdict, not a lookup result.
  const resolvedName = (name: string): string | undefined => {
    const resolution = resolveType(name);
    return resolution.kind === "resolved" ? resolution.name : undefined;
  };

  const agentConfig = (name: string): AgentConfig | undefined => {
    const key = resolvedName(name);
    return key ? agents.get(key) : undefined;
  };

  /** First non-hidden config: resolved type, then general-purpose, then undefined. */
  const activeConfig = (type: string): AgentConfig | undefined => {
    const config = agentConfig(type);
    if (config?.hidden !== true) return config;
    return agents.get("general-purpose");
  };

  return {
    register(userAgents, registerOptions) {
      agents.clear();
      if (!registerOptions?.disableDefaultAgents) {
        for (const [name, config] of DEFAULT_AGENTS) agents.set(name, config);
      }
      // User agents override defaults with the same name. Hidden agents stay
      // registered so settings can list them; spawning filters them out.
      for (const [name, config] of userAgents) agents.set(name, config);
    },

    setScanRoots(roots, disableDefaultAgents = false) {
      scanRoots = { ...roots };
      defaultAgentsDisabled = disableDefaultAgents;
    },

    setDefaultAgentsDisabled(disabled) {
      defaultAgentsDisabled = disabled;
      if (disabled) {
        for (const [name, config] of agents) {
          if (isBuiltinDefault(name, config)) agents.delete(name);
        }
        return;
      }
      for (const [name, config] of DEFAULT_AGENTS) {
        if (!agents.has(name)) agents.set(name, { ...config });
      }
    },

    async discoverNew(worktreeDir) {
      const result = await options.catalogue.execute({
        kind: "discover",
        roots: {
          ...scanRoots,
          ...(worktreeDir ? { worktreeDirectory: worktreeDir } : {}),
        },
        configuration: { disableDefaultAgents: defaultAgentsDisabled },
      });
      // A missing or empty directory is not a failure — the repository reports
      // it as an empty source. Reaching here means the scan itself broke, so
      // the caller reports that instead of answering "no new types".
      if (!result.ok) return { ok: false, message: result.error.message };

      let added = 0;
      for (const definition of result.catalogue.definitions) {
        if (agents.has(definition.name)) continue;
        agents.set(definition.name, toAgentConfig(definition));
        added += 1;
      }
      return { ok: true, added };
    },

    resolveType,
    agentConfig,

    availableTypes() {
      return [...agents.entries()]
        .filter(([, config]) => config.hidden !== true)
        .map(([name]) => name);
    },

    allTypes() {
      return [...agents.keys()];
    },

    policyInputs(type, defaults) {
      const config = agentConfig(type);
      if (!config) return undefined;
      const resolved = loadingPolicyFor(
        config,
        defaults.loadSkillsImplicitly,
        defaults.loadExtensionsImplicitly,
      );
      if (!resolved.ok) return undefined;
      // The round-trip strips undefined-valued optional properties the file
      // parser leaves behind, so the accepted boundary receives plain JSON.
      // The shape is unchanged, hence the assertion rather than a re-parse.
      return JSON.parse(JSON.stringify({
        ...resolved.policy,
        systemPromptMode: defaults.systemPromptMode,
        includeContextFiles: defaults.includeContextFiles,
        parentModelKey: defaults.parentModelKey,
      })) as AgentPolicyInputs;
    },

    resolvedConfig(type, loadSkillsImplicitly = true, loadExtensionsImplicitly = true) {
      const config = activeConfig(type) ?? DEFAULT_AGENTS.get("general-purpose")!;
      const resolved = loadingPolicyFor(config, loadSkillsImplicitly, loadExtensionsImplicitly);
      if (!resolved.ok) {
        return {
          displayName: config.displayName ?? config.name,
          description: config.description,
          registeredTools: [...BUILTIN_TOOL_NAMES],
          skills: loadSkillsImplicitly,
          extensions: loadExtensionsImplicitly,
        };
      }
      return {
        displayName: config.displayName ?? config.name,
        description: resolved.policy.definition.description,
        registeredTools: resolved.policy.registeredTools,
        tools: resolved.policy.tools,
        extensions: resolved.policy.extensions,
        skills: resolved.policy.skills,
      };
    },
  };
}
