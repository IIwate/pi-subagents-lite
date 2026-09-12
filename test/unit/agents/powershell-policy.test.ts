import { beforeEach, describe, expect, it } from "vitest";
import { AgentCatalogue, resolveDefaultRegisteredTools, adaptExploreRegisteredTools, resolveVisibleTools, resolveSessionAllowedTools, DEFAULT_FALLBACK_TOOLS, BUILTIN_TOOL_NAMES } from "../../../src/agents/agent-types.js";
let catalogue = new AgentCatalogue();
beforeEach(() => { catalogue = new AgentCatalogue(); });
import type { AgentConfig } from "../../../src/agents/types.js";

describe("defaultTools edge cases & sanitization", () => {
  beforeEach(() => {
    catalogue.registerAgents(new Map(), { disableDefaultAgents: false });
  });
  it("deduplicates redundant tool names in defaultTools", () => {
    const input = ["read", "powershell", "powershell", "edit", "read"];
    const result = resolveDefaultRegisteredTools(input);
    expect(result).toEqual(["read", "powershell", "edit"]);
  });

  it("strictly filters Agent tool even if maliciously or mistakenly included in defaultTools", () => {
    const input = ["read", "powershell", "Agent", "edit"];
    const result = resolveDefaultRegisteredTools(input);
    expect(result).not.toContain("Agent");
    expect(result).toEqual(["read", "powershell", "edit"]);
  });

  it("falls back to platform defaults when defaultTools only contains excluded tools", () => {
    const input = ["Agent"];
    const result = resolveDefaultRegisteredTools(input);
    expect(result).not.toContain("Agent");
    if (process.platform !== "win32") {
      expect(result).toEqual(DEFAULT_FALLBACK_TOOLS);
    }
  });

  it("falls back to platform defaults when defaultTools is an empty array", () => {
    const result = resolveDefaultRegisteredTools([]);
    if (process.platform !== "win32") {
      expect(result).toEqual(DEFAULT_FALLBACK_TOOLS);
    }
  });

  it("handles defaultTools with extension tool syntax", () => {
    const input = ["read", "tavily/web_search", "powershell"];
    const result = resolveDefaultRegisteredTools(input);
    expect(result).toEqual(["read", "tavily/web_search", "powershell"]);
  });
});

describe("Frontmatter policy conflicts & resolution order", () => {
  beforeEach(() => {
    catalogue.registerAgents(new Map(), { disableDefaultAgents: false });
  });

  it("tools whitelist wins over excludeTools when both are specified", () => {
    // tools has "powershell", excludeTools has "powershell"
    // Rule: tools wins over excludeTools
    const result = resolveVisibleTools({
      activeTools: ["read", "powershell", "edit"],
      tools: ["powershell", "read"],
      excludeTools: ["powershell"],
    });
    expect(result).toEqual(["powershell", "read"]);
  });

  it("tools: false strictly yields an empty tool list regardless of defaultTools", () => {
    const policy = catalogue.resolveAcceptedRunPolicy("general-purpose", {
      loadSkillsImplicitly: true,
      loadExtensionsImplicitly: true,
      systemPromptMode: "replace",
      includeContextFiles: true,
      parentModelKey: "parent/model",
      defaultTools: ["read", "powershell", "edit"],
    })!;

    const sessionTools = resolveSessionAllowedTools({
      registeredTools: policy.registeredTools,
      restrictToRegisteredTools: policy.restrictToRegisteredTools,
      tools: false,
    });
    expect(sessionTools).toEqual([]);

    const visibleTools = resolveVisibleTools({
      activeTools: ["read", "powershell"],
      tools: false,
    });
    expect(visibleTools).toEqual([]);
  });

  it("tools: true preserves active tools while stripping excluded tools", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "powershell", "Agent"],
      tools: true,
    });
    expect(result).toEqual(["read", "powershell"]);
    expect(result).not.toContain("Agent");
  });

  it("excludeTools: ['bash'] removes bash from active list containing powershell", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "powershell", "edit"],
      excludeTools: ["bash"],
    });
    expect(result).toEqual(["read", "powershell", "edit"]);
    expect(result).not.toContain("bash");
  });
});

describe("Explore agent adaptation edge cases", () => {
  it("does not mutate user-defined Explore agent (source !== undefined)", () => {
    const customExplore: AgentConfig = {
      name: "Explore",
      displayName: "Custom Explore",
      description: "Custom user explore agent",
      registeredTools: ["read", "find"],
      source: "project",
      systemPrompt: "custom prompt",
    };
    catalogue.registerAgents(new Map([["Explore", customExplore]]), { disableDefaultAgents: true });

    const policy = catalogue.resolveAcceptedRunPolicy("Explore", {
      loadSkillsImplicitly: true,
      loadExtensionsImplicitly: true,
      systemPromptMode: "replace",
      includeContextFiles: true,
      parentModelKey: "parent/model",
      defaultTools: ["powershell"],
    })!;

    expect(policy).toBeDefined();
    // User's explicit registeredTools ["read", "find"] should be preserved intact
    expect(policy.registeredTools).toEqual(["read", "find"]);
    expect(policy.registeredTools).not.toContain("powershell");
  });

  it("adaptExploreRegisteredTools handles tools list already containing powershell", () => {
    const tools = ["read", "powershell", "grep", "find"];
    const adapted = adaptExploreRegisteredTools(tools, ["powershell"]);
    expect(adapted).toEqual(["read", "powershell", "grep", "find"]);
  });

  it("adaptExploreRegisteredTools handles tools without read", () => {
    const tools = ["bash", "grep", "find"];
    const adapted = adaptExploreRegisteredTools(tools, ["powershell"]);
    expect(adapted).toContain("powershell");
    expect(adapted).toContain("read");
    expect(adapted).not.toContain("bash");
  });
});

describe("PowerShell visibility", () => {
  it("subagent allocated with powershell tool retains powershell in resolved visible set", () => {
    expect(BUILTIN_TOOL_NAMES).toContain("powershell");

    const visible = resolveVisibleTools({
      activeTools: ["read", "powershell", "edit", "write"],
      tools: ["powershell", "read"],
    });

    expect(visible).toEqual(["powershell", "read"]);
    expect(visible).not.toContain("bash");
  });
});
