/**
 * agent-registry.test.ts — The activation's live Agent type registry.
 *
 * Covers the session-state behavior the catalogue module cannot own: what the
 * registry answers now, how on-demand discovery changes that set mid-session,
 * how a broken scan is reported, and what the default-agent policy does to
 * already-registered definitions.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { makeAgentMd, tempDirWithFiles } from "../fixtures.ts";
import { createAgentCatalogueRuntime } from "../../src/bootstrap/agent-catalogue.js";
import { createAgentRegistry, type AgentConfig, type AgentRegistry } from "../../src/bootstrap/agent-registry.js";
import type { AgentCatalogue } from "../../src/modules/agent-catalogue/public.js";

function newRegistry(catalogue: AgentCatalogue = createAgentCatalogueRuntime()): AgentRegistry {
  const registry = createAgentRegistry({ catalogue });
  registry.setScanRoots({ globalDirectory: "/no-user-agents" });
  registry.register(new Map());
  return registry;
}

const DEFAULTS = {
  loadSkillsImplicitly: true,
  loadExtensionsImplicitly: true,
  systemPromptMode: "replace" as const,
  includeContextFiles: false,
  parentModelKey: "parent/main",
};

/* ------------------------------------------------------------------ */
/*  Registration and the default-agent policy (REQ-CATALOGUE-002)     */
/* ------------------------------------------------------------------ */

describe("agent registry — built-in type policy (REQ-CATALOGUE-002)", () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = newRegistry();
  });

  it("registers built-in types by default", () => {
    const types = registry.availableTypes();
    expect(types).toContain("general-purpose");
    expect(types).toContain("Explore");
  });

  it("skips built-in types when defaults are disabled at registration", () => {
    registry.register(new Map(), { disableDefaultAgents: true });
    expect(registry.availableTypes()).toEqual([]);
  });

  it("keeps user definitions while built-in types are disabled", () => {
    const userAgents = new Map<string, AgentConfig>([[
      "my-agent",
      { name: "my-agent", description: "Custom agent", systemPrompt: "test" },
    ]]);
    registry.register(userAgents, { disableDefaultAgents: true });
    expect(registry.availableTypes()).toContain("my-agent");
    expect(registry.availableTypes()).not.toContain("general-purpose");
  });

  it("keeps a same-name custom definition when the policy is toggled at runtime", () => {
    registry.register(new Map([[
      "general-purpose",
      {
        name: "general-purpose",
        description: "Custom general-purpose agent",
        systemPrompt: "custom",
        source: "project",
      },
    ]]));

    registry.setDefaultAgentsDisabled(true);
    expect(registry.availableTypes()).toEqual(["general-purpose"]);
    expect(registry.agentConfig("general-purpose")?.description).toBe("Custom general-purpose agent");

    registry.setDefaultAgentsDisabled(false);
    expect(registry.availableTypes()).toContain("Explore");
    expect(registry.agentConfig("general-purpose")?.description).toBe("Custom general-purpose agent");
  });

  it("preserves the disabled policy through on-demand discovery", async () => {
    const { dir: projectDir, cleanup } = tempDirWithFiles([
      { name: "custom.md", content: makeAgentMd({ name: "custom", description: "Custom" }) },
    ], "project-agents");

    try {
      registry.setScanRoots({ globalDirectory: "/no-user-agents", projectDirectory: projectDir }, true);
      registry.register(new Map(), { disableDefaultAgents: true });

      await registry.discoverNew();

      expect(registry.availableTypes()).toEqual(["custom"]);
    } finally {
      cleanup();
    }
  });

  it("falls back to a generic resolved config when no type answers", () => {
    registry.register(new Map(), { disableDefaultAgents: true });
    const config = registry.resolvedConfig("some-unknown-type");
    expect(config.displayName).toBe("Agent");
    expect(config.description).toBe("General-purpose agent for complex, multi-step tasks");
  });
});

/* ------------------------------------------------------------------ */
/*  On-demand discovery (REQ-CATALOGUE-001)                           */
/* ------------------------------------------------------------------ */

describe("agent registry — on-demand discovery (REQ-CATALOGUE-001)", () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = newRegistry();
  });

  it("discovers a worktree-local type when a worktree directory is supplied", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles([
      { name: "feature-reviewer.md", content: makeAgentMd({ name: "feature-reviewer", description: "Reviews feature branches" }) },
    ], "worktree-agents");

    try {
      registry.setScanRoots({ globalDirectory: "/no-user-agents", projectDirectory: projectDir });
      registry.register(new Map());

      expect(registry.resolveType("feature-reviewer")).toBeUndefined();

      const result = await registry.discoverNew(worktreeDir);
      expect(result).toMatchObject({ ok: true });
      expect(result.ok && result.added).toBeGreaterThanOrEqual(1);

      expect(registry.resolveType("feature-reviewer")).toBe("feature-reviewer");
      expect(registry.agentConfig("feature-reviewer")?.description).toBe("Reviews feature branches");
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("leaves a worktree-local type unresolved without a worktree directory", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { cleanup: cleanupWt } = tempDirWithFiles([
      { name: "feature-reviewer.md", content: makeAgentMd({ name: "feature-reviewer" }) },
    ], "worktree-agents");

    try {
      registry.setScanRoots({ globalDirectory: "/no-user-agents", projectDirectory: projectDir });
      registry.register(new Map());

      await registry.discoverNew();
      expect(registry.resolveType("feature-reviewer")).toBeUndefined();
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("keeps a discovered type registered for later calls", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles([
      { name: "wt-agent.md", content: makeAgentMd({ name: "wt-agent", description: "WT agent" }) },
    ], "worktree-agents");

    try {
      registry.setScanRoots({ globalDirectory: "/no-user-agents", projectDirectory: projectDir });
      registry.register(new Map());

      await registry.discoverNew(worktreeDir);
      expect(registry.resolveType("wt-agent")).toBe("wt-agent");

      const second = await registry.discoverNew();
      expect(registry.resolveType("wt-agent")).toBe("wt-agent");
      expect(second).toEqual({ ok: true, added: 0 });
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("scans the project root and the worktree in one pass", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([
      { name: "project-agent.md", content: makeAgentMd({ name: "project-agent", description: "Project" }) },
    ], "project-agents");
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles([
      { name: "wt-agent.md", content: makeAgentMd({ name: "wt-agent", description: "WT" }) },
    ], "worktree-agents");

    try {
      registry.setScanRoots({ globalDirectory: "/no-user-agents", projectDirectory: projectDir });
      registry.register(new Map());

      const result = await registry.discoverNew(worktreeDir);

      expect(registry.resolveType("project-agent")).toBe("project-agent");
      expect(registry.resolveType("wt-agent")).toBe("wt-agent");
      expect(result.ok && result.added).toBeGreaterThanOrEqual(2);
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("reports an absent worktree agents directory as no new types", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: baseDir, cleanup: cleanupBase } = tempDirWithFiles([], "nonexistent-base");

    try {
      registry.setScanRoots({ globalDirectory: "/no-user-agents", projectDirectory: projectDir });
      registry.register(new Map());

      const result = await registry.discoverNew(`${baseDir}/.pi/agents`);
      expect(result).toEqual({ ok: true, added: 0 });
    } finally {
      cleanupProject();
      cleanupBase();
    }
  });

  it("applies the parent scan's parsing rules to worktree definitions", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles([
      { name: "wt-agent.md", content: makeAgentMd({ name: "wt-agent", extensions: "read, bash", thinking: "high", max_turns: "50" }) },
    ], "worktree-agents");

    try {
      registry.setScanRoots({ globalDirectory: "/no-user-agents", projectDirectory: projectDir });
      registry.register(new Map());

      await registry.discoverNew(worktreeDir);
      const config = registry.agentConfig("wt-agent");
      expect(config).toBeDefined();
      expect(config!.extensions).toEqual(["read", "bash"]);
      // Retired frontmatter thinking never enters the Agent definition.
      expect(config).not.toHaveProperty("thinkingLevel");
      expect(config!.maxTurns).toBe(50);
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("treats an empty worktree directory as omitted", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([], "project-agents");
    const { cleanup: cleanupWt } = tempDirWithFiles([
      { name: "wt-agent.md", content: makeAgentMd({ name: "wt-agent" }) },
    ], "worktree-agents");

    try {
      registry.setScanRoots({ globalDirectory: "/no-user-agents", projectDirectory: projectDir });
      registry.register(new Map());

      expect(await registry.discoverNew("")).toEqual({ ok: true, added: 0 });
      expect(registry.resolveType("wt-agent")).toBeUndefined();
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("does not overwrite an already-registered definition", async () => {
    const { dir: projectDir, cleanup: cleanupProject } = tempDirWithFiles([
      { name: "shared.md", content: makeAgentMd({ name: "shared", description: "From project" }) },
    ], "project-agents");
    const { dir: worktreeDir, cleanup: cleanupWt } = tempDirWithFiles([
      { name: "wt-shared.md", content: makeAgentMd({ name: "shared", description: "From worktree" }) },
    ], "worktree-agents");

    try {
      registry.setScanRoots({ globalDirectory: "/no-user-agents", projectDirectory: projectDir });
      registry.register(new Map());

      await registry.discoverNew();
      expect(registry.agentConfig("shared")?.description).toBe("From project");

      const second = await registry.discoverNew(worktreeDir);
      expect(second).toEqual({ ok: true, added: 0 });
      expect(registry.agentConfig("shared")?.description).toBe("From project");
    } finally {
      cleanupProject();
      cleanupWt();
    }
  });

  it("reports a failed scan instead of answering no new types (REQ-CATALOGUE-001)", async () => {
    // A broken scan and an empty directory are different outcomes: reporting
    // the first as the second would tell the parent its type name was wrong.
    const failing: AgentCatalogue = {
      execute: async () => ({ ok: false, error: { code: "read-failed", message: "disk unavailable" } }),
    } as unknown as AgentCatalogue;
    const broken = newRegistry(failing);

    expect(await broken.discoverNew()).toEqual({ ok: false, message: "disk unavailable" });
  });
});

/* ------------------------------------------------------------------ */
/*  Accepted-call projection (REQ-AGENT-002)                          */
/* ------------------------------------------------------------------ */

describe("agent registry — accepted-call policy inputs (REQ-AGENT-002)", () => {
  it("deep-copies the accepted definition and resolves loading defaults", () => {
    const registry = newRegistry();
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
    registry.register(new Map([[config.name, config]]), { disableDefaultAgents: true });

    const policy = registry.policyInputs(config.name, {
      ...DEFAULTS,
      loadExtensionsImplicitly: false,
      systemPromptMode: "inherit",
      includeContextFiles: true,
    })!;

    config.registeredTools!.push("write");
    (config.tools as string[]).push("write");
    (config.extensions as string[]).push("later");
    (config.skills as string[]).push("later");
    config.excludeExtensions!.push("later");
    config.preloadSkills!.push("later");
    config.systemPrompt = "Mutated prompt";
    registry.register(new Map(), { disableDefaultAgents: true });

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
    expect(registry.policyInputs(config.name, DEFAULTS)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Effective loading settings (REQ-CATALOGUE-001)                    */
/* ------------------------------------------------------------------ */

describe("agent registry — effective loading settings (REQ-CATALOGUE-001)", () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = newRegistry();
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
      // extensions intentionally omitted — uses the session default
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
    registry.register(agents);
  });

  it("keeps an explicit skills: true over a disabled session default", () => {
    expect(registry.resolvedConfig("test-agent", false, true).skills).toBe(true);
  });

  it("keeps an explicit extensions: true over a disabled session default", () => {
    expect(registry.resolvedConfig("test-agent", true, false).extensions).toBe(true);
  });

  it("applies the session default when the definition is silent", () => {
    const off = registry.resolvedConfig("implicit-agent", false, false);
    expect(off.skills).toBe(false);
    expect(off.extensions).toBe(false);

    const on = registry.resolvedConfig("implicit-agent", true, true);
    expect(on.skills).toBe(true);
    expect(on.extensions).toBe(true);
  });

  it("keeps an explicit skills list and still applies the extensions default", () => {
    const result = registry.resolvedConfig("explicit-skills", false, false);
    expect(result.skills).toEqual(["tdd"]);
    expect(result.extensions).toBe(false);
  });

  it("keeps an explicit skills: false over an enabled session default", () => {
    const result = registry.resolvedConfig("no-skills", true, true);
    expect(result.skills).toBe(false);
    expect(result.extensions).toBe(false);
  });

  it("applies session defaults to an unknown type", () => {
    expect(registry.resolvedConfig("nonexistent", false, false).skills).toBe(false);
    expect(registry.resolvedConfig("nonexistent", true, true).skills).toBe(true);
  });
});
