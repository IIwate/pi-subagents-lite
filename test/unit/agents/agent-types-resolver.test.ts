/**
 * agent-types-resolver.test.ts — Tests for resolveVisibleTools.
 *
 * Verifies that the single-owner tool visibility resolver in agent-types.ts
 * correctly handles allowlist, denylist, ext/* expansion, and the
 * no-sub-subagent exclude policy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestHarness, type TestHarness } from "../../support/harness.js";

// Import the module under test
import { AgentCatalogue, resolveSessionAllowedTools, resolveVisibleTools, EXCLUDED_TOOL_NAMES, BUILTIN_TOOL_NAMES, DEFAULT_FALLBACK_TOOLS, resolveDefaultRegisteredTools, adaptExploreRegisteredTools } from "../../../src/agents/agent-types.js";
let catalogue = new AgentCatalogue();
beforeEach(() => { catalogue = new AgentCatalogue(); });
import { DEFAULT_AGENTS } from "../../../src/agents/default-agents.js";
import type { AgentConfig } from "../../../src/agents/types.js";

describe("resolveType name precedence", () => {
  let harness: TestHarness;
  beforeEach(() => { harness = createTestHarness(); });
  afterEach(async () => { await harness.dispose(); });

  it.each([false, true])("prefers canonical names with reversed registration %s", reverse => {
    const entries: [string, AgentConfig][] = [
      ["alias-owner", { name: "alias-owner", displayName: "probe", description: "", systemPrompt: "Alias" }],
      ["Probe", { name: "Probe", description: "", systemPrompt: "Canonical" }],
    ];
    catalogue.registerAgents(new Map(reverse ? entries.reverse() : entries), { disableDefaultAgents: true });
    expect(catalogue.resolveType("Probe")).toBe("Probe");
    expect(catalogue.resolveType("probe")).toBe("Probe");
    expect(catalogue.resolveType("alias-owner")).toBe("alias-owner");
  });

  it.each([false, true])("reports sorted ambiguities with reversed registration %s", reverse => {
    const entries: [string, AgentConfig][] = [
      ["Probe", { name: "Probe", displayName: "shared", description: "", systemPrompt: "First" }],
      ["PROBE", { name: "PROBE", displayName: "shared", description: "", systemPrompt: "Second" }],
    ];
    catalogue.registerAgents(new Map(reverse ? entries.reverse() : entries), { disableDefaultAgents: true });
    expect(catalogue.resolveType("Probe")).toBe("Probe");
    expect(() => catalogue.resolveType("probe")).toThrow('Ambiguous agent type "probe": PROBE, Probe.');
    expect(() => catalogue.resolveType("shared")).toThrow('Ambiguous agent type "shared": PROBE, Probe.');
  });
});

/* ------------------------------------------------------------------ */
/*  Sanity: constants                                                 */
/* ------------------------------------------------------------------ */

describe("EXCLUDED_TOOL_NAMES", () => {
  it("contains 'Agent' to prevent sub-subagent spawning", () => {
    expect(EXCLUDED_TOOL_NAMES).toContain("Agent");
  });
});

describe("BUILTIN_TOOL_NAMES", () => {
  it("is exported and non-empty", () => {
    expect(BUILTIN_TOOL_NAMES.length).toBeGreaterThan(0);
  });

  it("includes core built-in tools", () => {
    expect(BUILTIN_TOOL_NAMES).toContain("read");
    expect(BUILTIN_TOOL_NAMES).toContain("bash");
    expect(BUILTIN_TOOL_NAMES).toContain("edit");
    expect(BUILTIN_TOOL_NAMES).toContain("write");
  });
});

/* ------------------------------------------------------------------ */
/*  Allowlist mode (tools: string[])                                  */
/* ------------------------------------------------------------------ */

describe("resolveVisibleTools — allowlist mode", () => {
  it("returns only allowed tools", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit", "write", "grep"],
      tools: ["read", "bash", "edit"],
    });
    expect(result).toEqual(["read", "bash", "edit"]);
  });

  it("always excludes EXCLUDED_TOOL_NAMES", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit", "Agent"],
      tools: ["read", "bash", "edit", "Agent"],
    });
    expect(result).not.toContain("Agent");
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).toContain("edit");
  });

  it("returns [] when all active tools are excluded", () => {
    const result = resolveVisibleTools({
      activeTools: ["Agent"],
      tools: ["Agent"],
    });
    expect(result).toEqual([]);
  });

  it("ext/* expands to all tools from extension", () => {
    const extToolMap = new Map<string, string[]>();
    extToolMap.set("tavily", ["web_search", "web_extract", "web_crawl"]);

    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "web_search", "web_extract", "web_crawl"],
      tools: ["read", "tavily/*"],
      extToolMap,
    });
    expect(result).toContain("read");
    expect(result).toContain("web_search");
    expect(result).toContain("web_extract");
    expect(result).toContain("web_crawl");
    expect(result).not.toContain("bash");
  });

  it("ext/* with non-loaded extension: warns and resolves to nothing", () => {
    const notify = vi.fn();
    const extToolMap = new Map<string, string[]>();

    const result = resolveVisibleTools({
      activeTools: ["read", "bash"],
      tools: ["read", "tavily/*"],
      extToolMap,
      notify,
    });
    expect(result).toEqual(["read"]);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('extension "tavily" is not loaded, "tavily/*" will have no effect'),
    );
  });

  it("ext/tool syntax: extracts tool name from entry", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "web_search"],
      tools: ["read", "tavily/web_search"],
    });
    expect(result).toContain("read");
    expect(result).toContain("web_search");
    expect(result).not.toContain("bash");
  });

  it("warns about unknown bare tool name not in builtins or extensions", () => {
    const notify = vi.fn();

    const result = resolveVisibleTools({
      activeTools: ["read", "bash"],
      tools: ["read", "foobar"],
      notify,
    });
    expect(result).toEqual(["read"]);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('tool "foobar" not found in any loaded extension'),
    );
  });

  it("warns when extension is loaded but none of its tools are in tools", () => {
    const notify = vi.fn();
    const extToolMap = new Map<string, string[]>();
    extToolMap.set("tavily", ["web_search", "web_extract"]);

    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "web_search", "web_extract"],
      tools: ["read", "bash"],
      extToolMap,
      notify,
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).not.toContain("web_search");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('extension "tavily" is loaded but none of its tools are in tools'),
    );
  });

  it("does not warn when ext/* covers the extension", () => {
    const notify = vi.fn();
    const extToolMap = new Map<string, string[]>();
    extToolMap.set("tavily", ["web_search", "web_extract"]);

    resolveVisibleTools({
      activeTools: ["read", "web_search", "web_extract"],
      tools: ["read", "tavily/*"],
      extToolMap,
      notify,
    });
    // Should NOT warn about tavily having no tools in tools (ext/* covers it)
    expect(notify).not.toHaveBeenCalled();
  });

  it("ext/* combined with named extension tool", () => {
    const extToolMap = new Map<string, string[]>();
    extToolMap.set("tavily", ["web_search", "web_extract", "web_crawl"]);
    extToolMap.set("exa", ["exa_search"]);

    const result = resolveVisibleTools({
      activeTools: ["read", "web_search", "web_extract", "web_crawl", "exa_search"],
      tools: ["read", "tavily/*", "exa_search"],
      extToolMap,
    });
    expect(result).toContain("read");
    expect(result).toContain("web_search");
    expect(result).toContain("web_extract");
    expect(result).toContain("web_crawl");
    expect(result).toContain("exa_search");
  });
});

/* ------------------------------------------------------------------ */
/*  Denylist mode (excludeTools, no tools whitelist)                  */
/* ------------------------------------------------------------------ */

describe("resolveVisibleTools — denylist mode", () => {
  it("excludes tools listed in excludeTools", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit", "write"],
      tools: undefined,
      excludeTools: ["write"],
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).toContain("edit");
    expect(result).not.toContain("write");
  });

  it("always excludes EXCLUDED_TOOL_NAMES", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "Agent"],
      tools: undefined,
      excludeTools: ["write"],
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).not.toContain("Agent");
  });

  it("ext/* syntax in excludeTools", () => {
    const extToolMap = new Map<string, string[]>();
    extToolMap.set("tavily", ["web_search", "web_extract", "web_crawl"]);

    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "web_search", "web_extract", "web_crawl"],
      tools: undefined,
      excludeTools: ["tavily/*"],
      extToolMap,
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).not.toContain("web_search");
    expect(result).not.toContain("web_extract");
    expect(result).not.toContain("web_crawl");
  });

  it("mixed ext/* and bare names in excludeTools", () => {
    const extToolMap = new Map<string, string[]>();
    extToolMap.set("tavily", ["web_search", "web_extract"]);

    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "write", "web_search", "web_extract"],
      tools: undefined,
      excludeTools: ["write", "tavily/*"],
      extToolMap,
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).not.toContain("write");
    expect(result).not.toContain("web_search");
    expect(result).not.toContain("web_extract");
  });

  it("excludeTools is ignored when tools whitelist is set", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit", "write", "grep"],
      tools: ["read", "bash"],
      excludeTools: ["write"],
    });
    // tools whitelist wins — only read and bash
    expect(result).toEqual(["read", "bash"]);
  });

  it("returns null when no filtering needed (excludeTools doesn't match any active)", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit"],
      tools: undefined,
      excludeTools: ["write"],
    });
    expect(result).toBeNull();
  });

  it("returns [] when excludeTools removes all non-excluded active tools", () => {
    const result = resolveVisibleTools({
      activeTools: ["Agent", "write"],
      tools: undefined,
      excludeTools: ["write"],
    });
    expect(result).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  tools: true / false / undefined                                   */
/* ------------------------------------------------------------------ */

describe("resolveVisibleTools — tools: true/false/undefined", () => {
  it("tools: true — all tools visible except EXCLUDED_TOOL_NAMES", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit", "Agent"],
      tools: true,
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).toContain("edit");
    expect(result).not.toContain("Agent");
  });

  it("tools: true, no excluded tools in active — returns null", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit"],
      tools: true,
    });
    expect(result).toBeNull();
  });

  it("tools: false — returns []", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit"],
      tools: false,
    });
    expect(result).toEqual([]);
  });

  it("tools: undefined, no excluded tools — returns null", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit"],
      tools: undefined,
    });
    expect(result).toBeNull();
  });

  it("tools: undefined with Agent in activeTools — returns filtered list", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "Agent"],
      tools: undefined,
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).not.toContain("Agent");
  });

  it("tools: undefined with excludeTools — applies denylist", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit", "write"],
      tools: undefined,
      excludeTools: ["write"],
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).toContain("edit");
    expect(result).not.toContain("write");
  });
});

/* ------------------------------------------------------------------ */
/*  Session registry allowlist                                        */
/* ------------------------------------------------------------------ */

describe("resolveSessionAllowedTools", () => {
  it("leaves wildcard registries open for session_start tool registration", () => {
    expect(resolveSessionAllowedTools({
      registeredTools: ["read", "bash", "edit"],
      tools: ["read", "tavily/*"],
    })).toBeUndefined();
  });

  it("preserves an explicit registeredTools capability boundary", () => {
    expect(resolveSessionAllowedTools({
      registeredTools: ["read", "bash", "Agent"],
      restrictToRegisteredTools: true,
    })).toEqual(["read", "bash"]);
  });

  it("leaves unrestricted agent registries open for extension tools", () => {
    expect(resolveSessionAllowedTools({
      registeredTools: ["read", "bash", "edit"],
    })).toBeUndefined();
  });

  it("keeps concrete extension tool names in the immutable gate", () => {
    expect(resolveSessionAllowedTools({
      registeredTools: ["read", "bash"],
      tools: ["read", "tavily/web_search"],
    })).toEqual(["read", "web_search"]);
  });

  it("registers no tools when tools are disabled", () => {
    expect(resolveSessionAllowedTools({
      registeredTools: ["read", "bash"],
      tools: false,
    })).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  Edge cases                                                        */
/* ------------------------------------------------------------------ */

describe("resolveVisibleTools — edge cases", () => {
  it("empty activeTools with whitelist returns []", () => {
    const result = resolveVisibleTools({
      activeTools: [],
      tools: ["read"],
    });
    expect(result).toEqual([]);
  });

  it("notify is optional (no crash when omitted)", () => {
    expect(() => {
      resolveVisibleTools({
        activeTools: ["read"],
        tools: ["foobar"],
      });
    }).not.toThrow();
  });

  it("extToolMap is optional (no crash when omitted)", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash"],
      tools: ["read"],
    });
    expect(result).toEqual(["read"]);
  });
});

describe("resolveAcceptedRunPolicy", () => {
  it("deep-copies the accepted definition and resolves loading defaults", () => {
    const config: AgentConfig = {
      name: "snapshot-agent",
      description: "Snapshot policy",
      systemPrompt: "Original prompt",
      registeredTools: ["read"],
      tools: ["read"],
      extensions: ["original-extension"],
      skills: ["original-skill"],
      excludeExtensions: ["unsafe"],
      preloadSkills: ["review"],
      source: "project",
    };
    catalogue.registerAgents(new Map([[config.name, config]]), { disableDefaultAgents: true });

    const policy = catalogue.resolveAcceptedRunPolicy(config.name, {
      loadSkillsImplicitly: true,
      loadExtensionsImplicitly: false,
      systemPromptMode: "inherit",
      includeContextFiles: true,
      parentModelKey: "parent/main",
    })!;

    (config.registeredTools as string[]).push("write");
    (config.tools as string[]).push("write");
    (config.extensions as string[]).push("later");
    (config.skills as string[]).push("later");
    (config.excludeExtensions as string[]).push("later");
    (config.preloadSkills as string[]).push("later");
    config.systemPrompt = "Mutated prompt";
    catalogue.registerAgents(new Map(), { disableDefaultAgents: true });

    expect(policy).toMatchObject({
      registeredTools: ["read"],
      restrictToRegisteredTools: true,
      tools: ["read"],
      extensions: ["original-extension"],
      skills: ["original-skill"],
      systemPromptMode: "inherit",
      includeContextFiles: true,
      parentModelKey: "parent/main",
      definition: {
        systemPrompt: "Original prompt",
        excludeExtensions: ["unsafe"],
        preloadSkills: ["review"],
        source: "project",
      },
    });
    expect(catalogue.resolveAcceptedRunPolicy(config.name, {
      loadSkillsImplicitly: true,
      loadExtensionsImplicitly: true,
      systemPromptMode: "replace",
      includeContextFiles: false,
      parentModelKey: "parent/next",
    })).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  getConfig with global implicit defaults                           */
/* ------------------------------------------------------------------ */

describe("getConfig — global implicit defaults", () => {
  beforeEach(() => {
    // Register a test agent with skills: true and extensions: true
    const agents = new Map<string, AgentConfig>();
    agents.set("test-agent", {
      name: "test-agent",
      description: "Test agent",
      extensions: true,
      skills: true,
      systemPrompt: "test",
    });
    agents.set("implicit-agent", {
      name: "implicit-agent",
      description: "Agent with no skills/extensions set",
      systemPrompt: "test",
    });
    agents.set("explicit-skills", {
      name: "explicit-skills",
      description: "Agent with explicit skills list",
      // extensions intentionally omitted — uses global default
      skills: ["tdd"],
      systemPrompt: "test",
    });
    agents.set("no-skills", {
      name: "no-skills",
      description: "Agent with skills disabled",
      extensions: false,
      skills: false,
      systemPrompt: "test",
    });
    catalogue.registerAgents(agents);
  });

  it("agent with explicit skills: true ignores global loadSkillsImplicitly=false", () => {
    const result = catalogue.getConfig("test-agent", false, true);
    expect(result.skills).toBe(true);
  });

  it("agent with explicit extensions: true ignores global loadExtensionsImplicitly=false", () => {
    const result = catalogue.getConfig("test-agent", true, false);
    expect(result.extensions).toBe(true);
  });

  it("agent with no skills/extensions uses global default (false)", () => {
    const result = catalogue.getConfig("implicit-agent", false, false);
    expect(result.skills).toBe(false);
    expect(result.extensions).toBe(false);
  });

  it("agent with no skills/extensions uses global default (true)", () => {
    const result = catalogue.getConfig("implicit-agent", true, true);
    expect(result.skills).toBe(true);
    expect(result.extensions).toBe(true);
  });

  it("agent with skills: true gets global loadSkillsImplicitly=true", () => {
    const result = catalogue.getConfig("test-agent", true, true);
    expect(result.skills).toBe(true);
  });

  it("agent with explicit skills list ignores global default", () => {
    const result = catalogue.getConfig("explicit-skills", false, false);
    expect(result.skills).toEqual(["tdd"]);
    // extensions not explicitly set, so global default false applies
    expect(result.extensions).toBe(false);
  });

  it("agent with skills: false ignores global default", () => {
    const result = catalogue.getConfig("no-skills", true, true);
    expect(result.skills).toBe(false);
    expect(result.extensions).toBe(false);
  });

  it("unknown agent type uses global defaults", () => {
    const result = catalogue.getConfig("nonexistent", false, false);
    expect(result.skills).toBe(false);
    expect(result.extensions).toBe(false);
  });

  it("unknown agent type with load-all defaults to true", () => {
    const result = catalogue.getConfig("nonexistent", true, true);
    expect(result.skills).toBe(true);
    expect(result.extensions).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  PowerShell and defaultTools inheritance (AC-1 ~ AC-5)             */
/* ------------------------------------------------------------------ */

describe("PowerShell tool whitelist and exclusion (AC-1 ~ AC-3)", () => {
  it("AC-1: resolves tools with powershell without unknown extension warning", () => {
    const notify = vi.fn();
    const result = resolveVisibleTools({
      activeTools: ["read", "powershell", "bash", "edit"],
      tools: ["powershell", "read"],
      notify,
    });
    expect(result).toEqual(["powershell", "read"]);
    expect(notify).not.toHaveBeenCalledWith(
      expect.stringContaining('tool "powershell" not found in any loaded extension'),
    );
  });

  it("AC-2: correctly excludes powershell when excludeTools specifies it", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "powershell", "edit"],
      excludeTools: ["powershell"],
    });
    expect(result).toEqual(["read", "edit"]);
    expect(result).not.toContain("powershell");
  });

  it("AC-3: strictly excludes Agent even when powershell is present in active and allowed tools", () => {
    const visibleResult = resolveVisibleTools({
      activeTools: ["powershell", "Agent", "read"],
      tools: ["powershell", "Agent", "read"],
    });
    expect(visibleResult).not.toContain("Agent");
    expect(visibleResult).toContain("powershell");
    expect(visibleResult).toContain("read");

    const sessionAllowed = resolveSessionAllowedTools({
      registeredTools: ["powershell", "Agent", "read"],
      restrictToRegisteredTools: true,
    });
    expect(sessionAllowed).not.toContain("Agent");
    expect(sessionAllowed).toContain("powershell");
    expect(sessionAllowed).toContain("read");
  });
});

describe("defaultTools dynamic inheritance (AC-4 ~ AC-5)", () => {
  beforeEach(() => {
    // Re-register default agents
    catalogue.registerAgents(new Map(), { disableDefaultAgents: false });
  });

  it("AC-4: general-purpose inherits defaultTools containing powershell without bash", () => {
    const customDefaultTools = ["read", "powershell", "edit", "write"];
    const policy = catalogue.resolveAcceptedRunPolicy("general-purpose", {
      loadSkillsImplicitly: true,
      loadExtensionsImplicitly: true,
      systemPromptMode: "replace",
      includeContextFiles: true,
      parentModelKey: "parent/model",
      defaultTools: customDefaultTools,
    })!;

    expect(policy).toBeDefined();
    expect(policy.registeredTools).toEqual(["read", "powershell", "edit", "write"]);
    expect(policy.registeredTools).toContain("powershell");
    expect(policy.registeredTools).not.toContain("bash");
  });

  it("AC-5: general-purpose falls back to standard 6 tools when defaultTools is undefined", () => {
    const policy = catalogue.resolveAcceptedRunPolicy("general-purpose", {
      loadSkillsImplicitly: true,
      loadExtensionsImplicitly: true,
      systemPromptMode: "replace",
      includeContextFiles: true,
      parentModelKey: "parent/model",
      defaultTools: undefined,
    })!;

    expect(policy).toBeDefined();
    if (process.platform !== "win32") {
      expect(policy.registeredTools).toEqual(["read", "bash", "edit", "write", "grep", "find"]);
      expect(policy.registeredTools).not.toContain("powershell");
    }
  });

  it("resolveDefaultRegisteredTools respects custom list and fallback", () => {
    expect(resolveDefaultRegisteredTools(["powershell", "read"])).toEqual(["powershell", "read"]);
    if (process.platform !== "win32") {
      expect(resolveDefaultRegisteredTools(undefined)).toEqual(DEFAULT_FALLBACK_TOOLS);
      expect(resolveDefaultRegisteredTools([])).toEqual(DEFAULT_FALLBACK_TOOLS);
    }
  });
});

describe("Explore read-only agent Windows powershell fallback", () => {
  it("Explore system prompt includes read-only guidance for PowerShell", () => {
    const exploreConfig = DEFAULT_AGENTS.get("Explore");
    expect(exploreConfig).toBeDefined();
    expect(exploreConfig!.systemPrompt).toContain("PowerShell");
    expect(exploreConfig!.systemPrompt).toContain("Get-ChildItem");
    expect(exploreConfig!.systemPrompt).toContain("Select-String");
  });

  it("adaptExploreRegisteredTools adapts to PowerShell preference", () => {
    const baseTools = ["read", "bash", "grep", "find"];
    const adapted = adaptExploreRegisteredTools(baseTools, ["read", "powershell"]);
    expect(adapted).toContain("powershell");
    expect(adapted).not.toContain("bash");
  });
});
