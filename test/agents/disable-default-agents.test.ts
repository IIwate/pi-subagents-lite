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
import {
  registerAgents,
  getAvailableTypes,
  resolveType,
  getAgentConfig,
  setAgentScanDirs,
  setDefaultAgentsDisabled,
  discoverNewAgents,
  getConfig,
} from "../../src/agents/agent-types.js";
import type { AgentConfig } from "../../src/agents/types.js";
import { makeAgentMd, tempDirWithFiles } from "../fixtures.ts";

/* ------------------------------------------------------------------ */
/*  registerAgents with disableDefaultAgents                          */
/* ------------------------------------------------------------------ */

describe("registerAgents — disableDefaultAgents", () => {
  beforeEach(() => {
    registerAgents(new Map());
    setAgentScanDirs("", "");
  });

  it("includes DEFAULT_AGENTS by default (disableDefaultAgents=false)", () => {
    registerAgents(new Map());
    const types = getAvailableTypes();
    expect(types).toContain("general-purpose");
    expect(types).toContain("Explore");
  });

  it("skips DEFAULT_AGENTS when disableDefaultAgents is true", () => {
    registerAgents(new Map(), { disableDefaultAgents: true });
    const types = getAvailableTypes();
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
    registerAgents(userAgents, { disableDefaultAgents: true });
    const types = getAvailableTypes();
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
    registerAgents(userAgents, { disableDefaultAgents: true });
    const config = getAgentConfig("general-purpose");
    expect(config).toBeDefined();
    expect(config!.description).toBe("My custom general-purpose agent");
  });

  it("applies immediately without removing a custom default-name override", () => {
    registerAgents(new Map([[
      "general-purpose",
      {
        name: "general-purpose",
        description: "Custom general-purpose agent",
        systemPrompt: "custom",
        source: "project",
      },
    ]]));

    setDefaultAgentsDisabled(true);
    expect(getAvailableTypes()).toEqual(["general-purpose"]);
    expect(getAgentConfig("general-purpose")?.description).toBe("Custom general-purpose agent");

    setDefaultAgentsDisabled(false);
    expect(getAvailableTypes()).toContain("general-purpose");
    expect(getAvailableTypes()).toContain("Explore");
    expect(getAgentConfig("general-purpose")?.description).toBe("Custom general-purpose agent");
  });

  it("returns empty types when defaults disabled and no user agents", () => {
    registerAgents(new Map(), { disableDefaultAgents: true });
    expect(getAvailableTypes()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  On-demand discovery                                                */
/* ------------------------------------------------------------------ */

describe("discoverNewAgents - disableDefaultAgents", () => {
  beforeEach(() => {
    registerAgents(new Map());
    setAgentScanDirs("", "");
  });

  it("preserves the session policy while discovering a custom agent", async () => {
    const { dir: projectDir, cleanup } = tempDirWithFiles([
      { name: "custom.md", content: makeAgentMd({ name: "custom", description: "Custom" }) },
    ], "project-agents");

    try {
      setAgentScanDirs("", projectDir, true);
      registerAgents(new Map(), { disableDefaultAgents: true });

      await discoverNewAgents();

      expect(getAvailableTypes()).toEqual(["custom"]);
    } finally {
      cleanup();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  getConfig fallback when defaults are disabled                     */
/* ------------------------------------------------------------------ */

describe("getConfig — fallback when defaults disabled", () => {
  beforeEach(() => {
    registerAgents(new Map());
    setAgentScanDirs("", "");
  });

  it("falls back to generic config when defaults disabled and general-purpose missing", () => {
    registerAgents(new Map(), { disableDefaultAgents: true });
    const config = getConfig("some-unknown-type");
    // Should fall through to the absolute fallback (generic config)
    expect(config.displayName).toBe("Agent");
    expect(config.description).toBe("General-purpose agent for complex, multi-step tasks");
  });
});
