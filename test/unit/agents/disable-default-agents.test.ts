/**
 * disable-default-agents.test.ts — Tests for the disableDefaultAgents setting.
 *
 * Verifies:
 *   - When disableDefaultAgents is true, registerAgents skips DEFAULT_AGENTS
 *   - When disableDefaultAgents is false (default), DEFAULT_AGENTS are included
 *   - discoverNewAgents preserves the session's default-agent policy
 *   - User agents overriding a default by name still work when setting is on
 *   - getConfig falls back to generic config when defaults disabled and no user agents
 */

import { describe, it, expect, beforeEach } from "vitest";
import { AgentCatalogue } from "../../../src/agents/agent-types.js";
let catalogue = new AgentCatalogue();
beforeEach(() => { catalogue = new AgentCatalogue(); });
import type { AgentConfig } from "../../../src/agents/types.js";

/* ------------------------------------------------------------------ */
/*  registerAgents with disableDefaultAgents                          */
/* ------------------------------------------------------------------ */

describe("registerAgents — disableDefaultAgents", () => {
  beforeEach(() => {
    catalogue.registerAgents(new Map());
    catalogue.setAgentScanDirs("", "");
  });

  it("includes DEFAULT_AGENTS by default (disableDefaultAgents=false)", () => {
    catalogue.registerAgents(new Map());
    const types = catalogue.getAvailableTypes();
    expect(types).toContain("general-purpose");
    expect(types).toContain("Explore");
  });

  it("skips DEFAULT_AGENTS when disableDefaultAgents is true", () => {
    catalogue.registerAgents(new Map(), { disableDefaultAgents: true });
    const types = catalogue.getAvailableTypes();
    expect(types).not.toContain("general-purpose");
    expect(types).not.toContain("Explore");
  });

  it("still includes user-defined agents when disableDefaultAgents is true", () => {
    const userAgents = new Map<string, AgentConfig>();
    userAgents.set("my-agent", {
      name: "my-agent",
      description: "Custom agent",
      systemPrompt: "test",
    });
    catalogue.registerAgents(userAgents, { disableDefaultAgents: true });
    const types = catalogue.getAvailableTypes();
    expect(types).toContain("my-agent");
    expect(types).not.toContain("general-purpose");
  });

  it("user agent overriding a default by name is still registered when setting is on", () => {
    const userAgents = new Map<string, AgentConfig>();
    userAgents.set("general-purpose", {
      name: "general-purpose",
      description: "My custom general-purpose agent",
      systemPrompt: "custom prompt",
    });
    catalogue.registerAgents(userAgents, { disableDefaultAgents: true });
    const config = catalogue.getAgentConfig("general-purpose");
    expect(config).toBeDefined();
    expect(config!.description).toBe("My custom general-purpose agent");
  });

  it("applies immediately without removing a custom default-name override", () => {
    catalogue.registerAgents(new Map([[
      "general-purpose",
      {
        name: "general-purpose",
        description: "Custom general-purpose agent",
        systemPrompt: "custom",
        source: "project",
      },
    ]]));

    catalogue.setDefaultAgentsDisabled(true);
    expect(catalogue.getAvailableTypes()).toEqual(["general-purpose"]);
    expect(catalogue.getAgentConfig("general-purpose")?.description).toBe("Custom general-purpose agent");

    catalogue.setDefaultAgentsDisabled(false);
    expect(catalogue.getAvailableTypes()).toContain("general-purpose");
    expect(catalogue.getAvailableTypes()).toContain("Explore");
    expect(catalogue.getAgentConfig("general-purpose")?.description).toBe("Custom general-purpose agent");
  });

  it("returns empty types when defaults disabled and no user agents", () => {
    catalogue.registerAgents(new Map(), { disableDefaultAgents: true });
    expect(catalogue.getAvailableTypes()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  getConfig fallback when defaults are disabled                     */
/* ------------------------------------------------------------------ */

describe("getConfig — fallback when defaults disabled", () => {
  beforeEach(() => {
    catalogue.registerAgents(new Map());
    catalogue.setAgentScanDirs("", "");
  });

  it("falls back to generic config when defaults disabled and general-purpose missing", () => {
    catalogue.registerAgents(new Map(), { disableDefaultAgents: true });
    const config = catalogue.getConfig("some-unknown-type");
    // Should fall through to the absolute fallback (generic config)
    expect(config.displayName).toBe("Agent");
    expect(config.description).toBe("General-purpose agent for complex, multi-step tasks");
  });
});
