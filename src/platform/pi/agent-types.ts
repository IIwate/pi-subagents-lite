/**
 * agent-types.ts — Tool visibility policy for a subagent session.
 *
 * Pure rules over names: which tool schemas an agent may see, and which set the
 * host session may register. Inherited-tool exclusion is owned by
 * agent-catalogue; this file applies that module function to the live roster.
 * The live type registry lives in bootstrap; nothing here holds state.
 */

import { excludeInheritedTools } from "../../modules/agent-catalogue/public.js";

/**
 * All tool names that Pi can provide to a session.
 *
 * Note: only `read`, `bash`, `edit`, `write` are active by default.
 * `find` and `grep` must be explicitly activated via setActiveToolsByName().
 * `ls` was removed — it's a thin wrapper over bash that adds ~180 tokens/turn
 * with no real benefit.
 */
export const BUILTIN_TOOL_NAMES: string[] = ["read", "bash", "edit", "write", "grep", "find"];

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

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
 * Host visibility selection over the live roster. Handles:
 *   - `tools: true` → all active tools (minus catalogue inherited-tool exclusion)
 *   - `tools: string[]` → allowlist (minus inherited tools, with ext/* expansion)
 *   - `tools: false` → no tools
 *   - `tools: undefined` + `excludeTools` → denylist (minus inherited tools, with ext/* expansion)
 *   - `tools: undefined` → all active tools (minus inherited tools if any are present)
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
    const filtered = excludeInheritedTools(activeTools.filter(t => !excludeSet.has(t)));
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

    const visibleSet = new Set<string>();
    for (const t of activeTools) {
      if (allowedTools.has(t)) {
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

    return excludeInheritedTools([...visibleSet]);
  }

  if (tools === false) {
    return [];
  }

  // tools: true or undefined — all tools visible except catalogue inherited tools
  const filtered = excludeInheritedTools(activeTools);
  return filtered.length === activeTools.length ? null : filtered;
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
    return excludeInheritedTools([...resolveToolEntries(opts.tools, undefined)]);
  }

  if (!opts.restrictToRegisteredTools) return undefined;
  return excludeInheritedTools(opts.registeredTools);
}
