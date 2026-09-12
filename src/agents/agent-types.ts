/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded default agents with user-defined agents from .pi/agents/*.md.
 * User agents override defaults with the same name. Disabled agents are kept but excluded from spawning.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { scanAgentFilesInDir, mergeAgents } from "./agent-discovery.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import type { AcceptedRunPolicy } from "../types.js";
import type { AgentConfig, SystemPromptMode } from "./types.js";

/**
 * Check if bash is available on the current host.
 * Always true on non-Windows platforms. On Windows, verifies standard Git Bash paths and PATH.
 */
export function isBashAvailable(): boolean {
  if (process.platform !== "win32") return true;

  const candidates = [
    process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Git\\bin\\bash.exe` : "",
    process.env["ProgramFiles(x86)"] ? `${process.env["ProgramFiles(x86)"]}\\Git\\bin\\bash.exe` : "",
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe` : "",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return true;
    } catch {
      // Ignore filesystem access errors
    }
  }

  try {
    const res = spawnSync("where", ["bash.exe"], {
      timeout: 1000,
      stdio: "ignore",
      windowsHide: true,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * All tool names that Pi can provide to a session.
 *
 * Note: only `read`, `bash` (or `powershell`), `edit`, `write` are active by default.
 * `find` and `grep` must be explicitly activated via setActiveToolsByName().
 * `ls` was removed — it's a thin wrapper over bash that adds ~180 tokens/turn
 * with no real benefit.
 */
export const BUILTIN_TOOL_NAMES: string[] = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
];

/** Default 6-tool fallback matching legacy behavior on Linux/macOS. */
export const DEFAULT_FALLBACK_TOOLS: string[] = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
];

/** Tool names excluded from child sessions to prevent recursive delegation. */
export const EXCLUDED_TOOL_NAMES = ["Agent"];

/**
 * Resolve default registered tools when an agent definition does not declare registeredTools.
 *
 * 1. If explicit defaultTools is provided and non-empty, inherit it directly.
 * 2. If no defaultTools and running on Windows without bash, substitute bash with powershell.
 * 3. Otherwise fall back to the standard 6 tools (read, bash, edit, write, grep, find).
 */
export function resolveDefaultRegisteredTools(defaultTools?: string[]): string[] {
  if (defaultTools && defaultTools.length > 0) {
    const sanitized = Array.from(new Set(defaultTools.filter(t => !EXCLUDED_TOOL_NAMES.includes(t))));
    if (sanitized.length > 0) return sanitized;
  }
  if (process.platform === "win32" && !isBashAvailable()) {
    return ["read", "powershell", "edit", "write", "grep", "find"];
  }
  return [...DEFAULT_FALLBACK_TOOLS];
}

/**
 * Adapt registered tools for default built-in Explore agent on Windows or when PowerShell is preferred.
 */
export function adaptExploreRegisteredTools(tools: string[], defaultTools?: string[]): string[] {
  const prefersPwsh = Boolean(
    (defaultTools?.includes("powershell") && !defaultTools?.includes("bash")) ||
    (process.platform === "win32" && !isBashAvailable())
  );
  if (prefersPwsh) {
    return ["read", "powershell", ...tools.filter(t => t !== "read" && t !== "bash" && t !== "powershell")];
  }
  if (process.platform === "win32" && !tools.includes("powershell")) {
    return [...tools, "powershell"];
  }
  return tools;
}

/** Options for registerAgents. */
export interface RegisterAgentsOptions {
  /** When true, skip built-in DEFAULT_AGENTS. */
  disableDefaultAgents?: boolean;
}

/** Built-ins have no source; every merged global/project definition has one. */
function isBuiltinDefault(name: string, config: AgentConfig): boolean {
  return DEFAULT_AGENTS.has(name) && config.source === undefined;
}

/**
 * Resolve tool entries (with ext/* syntax) into concrete tool names.
 * Supports:
 *   - bare tool names: "read" → "read"
 *   - ext/* syntax: "tavily/*" → all tools from the tavily extension
 *   - ext/tool syntax: "tavily/web_search" → "web_search"
 */
function resolveToolEntries(
  entries: string[],
  extToolMap: Map<string, string[]> | undefined,
  notify?: (msg: string) => void,
): Set<string> {
  const resolved = new Set<string>();

  for (const entry of entries) {
    const slashIdx = entry.indexOf("/");
    if (slashIdx !== -1) {
      // ext/* or ext/tool syntax
      const extName = entry.slice(0, slashIdx);
      const toolPart = entry.slice(slashIdx + 1);
      if (toolPart === "*") {
        const extTools = extToolMap?.get(extName);
        if (extTools && extTools.length > 0) {
          for (const t of extTools) resolved.add(t);
        } else {
          notify?.(`extension "${extName}" is not loaded, "${entry}" will have no effect`);
        }
      } else {
        // ext/tool syntax: e.g. "tavily/web_search"
        resolved.add(toolPart);
      }
    } else {
      // Bare tool name
      resolved.add(entry);
    }
  }

  return resolved;
}

/**
 * Resolve the visible tool set for an agent type from its config.
 *
 * Single owner of tool visibility policy. Handles:
 *   - `tools: true` → all active tools (minus excluded)
 *   - `tools: string[]` → allowlist (minus excluded, with ext/* expansion)
 *   - `tools: false` → no tools
 *   - `tools: undefined` + `excludeTools` → denylist (minus excluded, with ext/* expansion)
 *   - `tools: undefined` → all active tools (minus EXCLUDED_TOOL_NAMES if any are present)
 *
 * `tools` and `excludeTools` are mutually exclusive. If both set, `tools` wins.
 *
 * Returns null when no filtering is needed, otherwise the filtered tool list.
 */
export function resolveVisibleTools(opts: {
  activeTools: string[];
  tools?: true | string[] | false;
  excludeTools?: string[];
  extToolMap?: Map<string, string[]>;
  notify?: (msg: string) => void;
}): string[] | null {
  const { activeTools, tools, excludeTools, extToolMap, notify } = opts;

  // Blacklist mode: excludeTools set and tools not set as whitelist
  if (excludeTools && !Array.isArray(tools)) {
    const excludeSet = resolveToolEntries(excludeTools, extToolMap, notify);
    const filtered = activeTools.filter(t =>
      !EXCLUDED_TOOL_NAMES.includes(t) && !excludeSet.has(t)
    );
    return filtered.length !== activeTools.length ? filtered : null;
  }

  if (Array.isArray(tools)) {
    // Whitelist mode: resolve entries with ext/* expansion
    const allBuiltinSet = new Set(BUILTIN_TOOL_NAMES);
    const allowedTools = resolveToolEntries(tools, extToolMap, notify);

    // Warn about unknown entries
    for (const entry of tools) {
      const slashIdx = entry.indexOf("/");
      if (slashIdx === -1 && !allBuiltinSet.has(entry)) {
        // Bare name, not a known built-in — check if it's an extension tool
        let foundInExt = false;
        for (const [, extToolNames] of extToolMap ?? []) {
          if (extToolNames.includes(entry)) { foundInExt = true; break; }
        }
        if (!foundInExt) {
          notify?.(`tool "${entry}" not found in any loaded extension`);
        }
      }
    }

    const activeSet = new Set(activeTools);
    const visibleSet = new Set<string>();
    for (const t of allowedTools) {
      if (EXCLUDED_TOOL_NAMES.includes(t)) continue;
      if (activeSet.has(t)) {
        visibleSet.add(t);
      }
    }

    // Warn if a loaded extension has none of its tools in `tools`
    if (extToolMap) {
      for (const [extName, extTools] of extToolMap) {
        const hasAny = extTools.some(t => allowedTools.has(t));
        if (!hasAny) {
          notify?.(`extension "${extName}" is loaded but none of its tools are in tools: [${tools.join(", ")}]`);
        }
      }
    }

    return [...visibleSet];
  }

  if (tools === false) {
    return [];
  }

  // tools: true or undefined — all tools visible (except excluded)
  const hasExcluded = activeTools.some(t => EXCLUDED_TOOL_NAMES.includes(t));
  if (!hasExcluded) return null;
  return activeTools.filter(t => !EXCLUDED_TOOL_NAMES.includes(t));
}

/**
 * Resolve Pi's immutable child-session registry gate.
 *
 * Unrestricted agents and extension wildcards must omit the gate because extensions may
 * register tools during session_start, after createAgentSession has frozen the allowlist.
 * resolveVisibleTools applies the final policy before the first prompt. Revisit when Pi
 * exposes a mutable registry allowlist.
 */
export function resolveSessionAllowedTools(opts: {
  registeredTools: string[];
  restrictToRegisteredTools?: boolean;
  tools?: true | string[] | false;
}): string[] | undefined {
  if (opts.tools === false) return [];

  if (Array.isArray(opts.tools)) {
    if (opts.tools.some(tool => tool.endsWith("/*"))) return undefined;
    return [...resolveToolEntries(opts.tools, undefined)]
      .filter(tool => !EXCLUDED_TOOL_NAMES.includes(tool));
  }

  if (!opts.restrictToRegisteredTools) return undefined;
  return opts.registeredTools.filter(tool => !EXCLUDED_TOOL_NAMES.includes(tool));
}

/** Resolved config shape returned by getConfig. */
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
 * Apply global implicit defaults to skills/extensions.
 * undefined means "not explicitly set" → resolve from global default.
 * Concrete values (true, false, string[]) pass through unchanged.
 */
function applyGlobalDefaults(
  skills: true | string[] | false | undefined,
  extensions: true | string[] | false | undefined,
  loadSkillsImplicitly: boolean,
  loadExtensionsImplicitly: boolean,
): { skills: true | string[] | false; extensions: true | string[] | false } {
  return {
    skills: skills === undefined ? loadSkillsImplicitly : skills,
    extensions: extensions === undefined ? loadExtensionsImplicitly : extensions,
  };
}


/** Activation-owned definitions and discovery roots. */
export class AgentCatalogue {
  private readonly agents = new Map<string, AgentConfig>();
  private userAgentDir = "";
  private projectAgentDir = "";
  private defaultAgentsDisabled = false;

  constructor() { this.registerAgents(new Map()); }

  registerAgents(userAgents: Map<string, AgentConfig>, options?: RegisterAgentsOptions): void {
    this.agents.clear();

    // Start with defaults (unless disabled)
    if (!options?.disableDefaultAgents) {
      for (const [name, config] of DEFAULT_AGENTS) {
        this.agents.set(name, structuredClone(config));
      }
    }

    // Overlay user agents (overrides defaults with same name)
    for (const [name, config] of userAgents) {
      this.agents.set(name, structuredClone(config));
    }
  }

  setAgentScanDirs(
    userDir: string,
    projectDir: string,
    disableDefaultAgents = false,
  ): void {
    this.userAgentDir = userDir;
    this.projectAgentDir = projectDir;
    this.defaultAgentsDisabled = disableDefaultAgents;
  }

  setDefaultAgentsDisabled(disabled: boolean): void {
    this.defaultAgentsDisabled = disabled;
    if (disabled) {
      for (const [name, config] of this.agents) {
        if (isBuiltinDefault(name, config)) this.agents.delete(name);
      }
      return;
    }

    for (const [name, config] of DEFAULT_AGENTS) {
      if (!this.agents.has(name)) this.agents.set(name, structuredClone(config));
    }
  }

  async scanAndMerge(options?: { disableDefaultAgents?: boolean }): Promise<Map<string, AgentConfig>> {
    const [userAgents, projectAgents] = await Promise.all([
      scanAgentFilesInDir(this.userAgentDir, "user"),
      scanAgentFilesInDir(this.projectAgentDir, "project"),
    ]);
    const defaults = options?.disableDefaultAgents ? new Map<string, AgentConfig>() : DEFAULT_AGENTS;
    return mergeAgents(defaults, userAgents, projectAgents);
  }

  async discoverNewAgents(worktreeDir?: string): Promise<number> {
    const merged = await this.scanAndMerge({ disableDefaultAgents: this.defaultAgentsDisabled });

    let count = 0;
    for (const [name, config] of merged) {
      if (!this.agents.has(name)) {
        this.agents.set(name, structuredClone(config));
        count++;
      }
    }

    // Scan worktree-local agents (only when worktreeDir is provided)
    if (worktreeDir) {
      const worktreeAgents = await scanAgentFilesInDir(worktreeDir, "project");
      const wtMerged = mergeAgents(new Map(), [], worktreeAgents);
      for (const [name, config] of wtMerged) {
        if (!this.agents.has(name)) {
          this.agents.set(name, structuredClone(config));
          count++;
        }
      }
    }

    return count;
  }

  resolveType(name: string): string | undefined {
    if (!name) return undefined;
    if (this.agents.has(name)) return name;
    const lower = name.toLowerCase();
    const canonical = [...this.agents.keys()].filter(key => key.toLowerCase() === lower);
    const matches = canonical.length > 0 ? canonical : [...this.agents.entries()]
      .filter(([, config]) => config.displayName?.toLowerCase() === lower)
      .map(([key]) => key);
    if (matches.length > 1) {
      throw new Error(`Ambiguous agent type ${JSON.stringify(name)}: ${matches.sort().join(", ")}. Use an exact canonical name.`);
    }
    return matches[0];
  }

  getAgentConfig(name: string): AgentConfig | undefined {
    const key = this.resolveType(name);
    return key ? this.agents.get(key) : undefined;
  }

  resolveAcceptedRunPolicy(
    type: string,
    defaults: {
      loadSkillsImplicitly: boolean;
      loadExtensionsImplicitly: boolean;
      systemPromptMode: SystemPromptMode;
      includeContextFiles: boolean;
      parentModelKey: string;
      defaultTools?: string[];
    },
  ): AcceptedRunPolicy | undefined {
    const key = this.resolveType(type);
    const config = key ? this.agents.get(key) : undefined;
    if (!config) return undefined;

    const definition = structuredClone(config);
    const resolved = applyGlobalDefaults(
      definition.skills,
      definition.extensions,
      defaults.loadSkillsImplicitly,
      defaults.loadExtensionsImplicitly,
    );

    let registeredTools = definition.registeredTools?.length
      ? [...definition.registeredTools]
      : resolveDefaultRegisteredTools(defaults.defaultTools);

    if (key === "Explore" && definition.source === undefined) {
      registeredTools = adaptExploreRegisteredTools(registeredTools, defaults.defaultTools);
    }

    return {
      definition,
      registeredTools,
      restrictToRegisteredTools: Boolean(definition.registeredTools?.length),
      tools: Array.isArray(definition.tools) ? [...definition.tools] : definition.tools,
      extensions: Array.isArray(resolved.extensions) ? [...resolved.extensions] : resolved.extensions,
      skills: Array.isArray(resolved.skills) ? [...resolved.skills] : resolved.skills,
      systemPromptMode: defaults.systemPromptMode,
      includeContextFiles: defaults.includeContextFiles,
      parentModelKey: defaults.parentModelKey,
    };
  }

  getAvailableTypes(): string[] {
    return [...this.agents.entries()]
      .filter(([_, config]) => config.hidden !== true)
      .map(([name]) => name);
  }

  getAllTypes(): string[] {
    return [...this.agents.keys()];
  }

  getToolNamesForType(type: string, defaultTools?: string[]): string[] {
    const config = this.getAgentConfig(type);
    let tools = config?.registeredTools?.length
      ? config.registeredTools
      : resolveDefaultRegisteredTools(defaultTools);

    const key = this.resolveType(type);
    if (key === "Explore" && config?.source === undefined) {
      tools = adaptExploreRegisteredTools(tools, defaultTools);
    }
    return tools;
  }

  findActiveConfig(type: string): AgentConfig | undefined {
    const key = this.resolveType(type);
    const config = key ? this.agents.get(key) : undefined;
    if (config?.hidden !== true) return config;
    return this.agents.get("general-purpose");
  }

  getConfig(
    type: string,
    loadSkillsImplicitly: boolean = true,
    loadExtensionsImplicitly: boolean = true,
    defaultTools?: string[],
  ): ResolvedAgentConfig {
    const config = this.findActiveConfig(type);
    if (config) {
      const { skills, extensions, ...rest } = config;
      const defaults = applyGlobalDefaults(skills, extensions, loadSkillsImplicitly, loadExtensionsImplicitly);
      let registeredTools = rest.registeredTools?.length
        ? rest.registeredTools
        : resolveDefaultRegisteredTools(defaultTools);

      const key = this.resolveType(type);
      if (key === "Explore" && config.source === undefined) {
        registeredTools = adaptExploreRegisteredTools(registeredTools, defaultTools);
      }

      return {
        displayName: rest.displayName ?? rest.name,
        description: rest.description,
        registeredTools,
        tools: rest.tools,
        ...defaults,
      };
    }

    // Absolute fallback — no config found at all
    const defaults = applyGlobalDefaults(undefined, undefined, loadSkillsImplicitly, loadExtensionsImplicitly);
    const generalPurpose = DEFAULT_AGENTS.get("general-purpose")!;
    return {
      displayName: generalPurpose.displayName ?? generalPurpose.name,
      description: generalPurpose.description,
      registeredTools: resolveDefaultRegisteredTools(defaultTools),
      ...defaults,
    };
  }
}
