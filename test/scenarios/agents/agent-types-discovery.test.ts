import { createTestHarness, type TestHarness } from "../../support/harness.js";
/**
 * Tests for worktree-local agent type discovery.
 *
 * Verifies:
 *   - discoverNewAgents scans the worktree's .pi/agents/ when worktreeDir is set
 *   - Worktree-local types are discovered and added to the session-wide registry
 *   - Worktree scan does not interfere with existing parent/global discovery
 *   - Missing or non-existent worktree .pi/agents/ dir is handled gracefully
 *   - Worktree-local type fails to resolve without worktreeDir (not in parent/global)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeAgentMd, tempDirWithFiles } from "../../support/fixtures.js";
import {
  registerAgents,
  setAgentScanDirs,
  discoverNewAgents,
  resolveType,
  getAgentConfig,
  getAvailableTypes,
} from "../../../src/agents/agent-types.js";

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

let harness: TestHarness;
beforeEach(() => { harness = createTestHarness(); });
afterEach(async () => { await harness.dispose(); });

describe("discoverNewAgents — worktree-local agent types", () => {
  beforeEach(() => {
    // Reset to clean state: just the default agents
    registerAgents(new Map());
    // Clear scan dirs so they don't pollute tests
    setAgentScanDirs("", "");
  });

  it("discovers a worktree-local agent type when worktreeDir is set", async () => {
    const projectDir = tempDirWithFiles(harness, [], "project-agents");
    const worktreeDir = tempDirWithFiles(harness, [
      { name: "feature-reviewer.md", content: makeAgentMd({ name: "feature-reviewer", description: "Reviews feature branches" }) },
    ], "worktree-agents");

    setAgentScanDirs("", projectDir);
    registerAgents(new Map());

    // Not known before discovery
    expect(resolveType("feature-reviewer")).toBeUndefined();

    // Discover with worktree dir
    const count = await discoverNewAgents(worktreeDir);
    expect(count).toBeGreaterThanOrEqual(1);

    // Now it should be resolved
    expect(resolveType("feature-reviewer")).toBe("feature-reviewer");
    expect(getAgentConfig("feature-reviewer")?.description).toBe("Reviews feature branches");
  });

  it("worktree-local type is NOT found without worktreeDir", async () => {
    const projectDir = tempDirWithFiles(harness, [], "project-agents");
    tempDirWithFiles(harness, [
      { name: "feature-reviewer.md", content: makeAgentMd({ name: "feature-reviewer" }) },
    ], "worktree-agents");

    setAgentScanDirs("", projectDir);
    registerAgents(new Map());

    // Discover WITHOUT worktree dir — should not find the worktree type
    await discoverNewAgents();
    expect(resolveType("feature-reviewer")).toBeUndefined();
  });

  it("worktree scan adds to session-wide registry, visible to subsequent spawns", async () => {
    const projectDir = tempDirWithFiles(harness, [], "project-agents");
    const worktreeDir = tempDirWithFiles(harness, [
      { name: "wt-agent.md", content: makeAgentMd({ name: "wt-agent", description: "WT agent" }) },
    ], "worktree-agents");

    setAgentScanDirs("", projectDir);
    registerAgents(new Map());

    // First discovery with worktree
    await discoverNewAgents(worktreeDir);
    expect(resolveType("wt-agent")).toBe("wt-agent");

    // Second discovery WITHOUT worktree — should still be in registry
    const count = await discoverNewAgents();
    expect(resolveType("wt-agent")).toBe("wt-agent");
    expect(count).toBe(0); // No new agents (already known)
  });

  it("worktree scan does not interfere with existing parent/global discovery", async () => {
    const projectDir = tempDirWithFiles(harness, [
      { name: "project-agent.md", content: makeAgentMd({ name: "project-agent", description: "Project" }) },
    ], "project-agents");
    const worktreeDir = tempDirWithFiles(harness, [
      { name: "wt-agent.md", content: makeAgentMd({ name: "wt-agent", description: "WT" }) },
    ], "worktree-agents");

    setAgentScanDirs("", projectDir);
    registerAgents(new Map());

    const count = await discoverNewAgents(worktreeDir);

    // Both project and worktree types should be discovered
    expect(resolveType("project-agent")).toBe("project-agent");
    expect(resolveType("wt-agent")).toBe("wt-agent");
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("handles missing worktree .pi/agents/ directory gracefully (no error)", async () => {
    const projectDir = tempDirWithFiles(harness, [], "project-agents");
    const nonexistentDir = tempDirWithFiles(harness, [], "nonexistent-base");

    setAgentScanDirs("", projectDir);
    registerAgents(new Map());

    // Point to a directory that doesn't have .pi/agents/ — should not error
    const fakeWorktreeDir = nonexistentDir + "/.pi/agents";
    const count = await discoverNewAgents(fakeWorktreeDir);
    expect(count).toBe(0);
  });

  it("uses the same parsing rules as the parent scan (frontmatter format, name field)", async () => {
    const projectDir = tempDirWithFiles(harness, [], "project-agents");
    const worktreeDir = tempDirWithFiles(harness, [
      { name: "wt-agent.md", content: makeAgentMd({ name: "wt-agent", extensions: "read, bash", thinking: "high", max_turns: "50" }) },
    ], "worktree-agents");

    setAgentScanDirs("", projectDir);
    registerAgents(new Map());

    await discoverNewAgents(worktreeDir);
    const config = getAgentConfig("wt-agent");
    expect(config).toBeDefined();
    // Extensions parsed correctly
    expect(config!.extensions).toEqual(["read", "bash"]);
    // Thinking parsed correctly
    expect(config!.thinkingLevel).toBe("high");
    // Max turns parsed correctly
    expect(config!.maxTurns).toBe(50);
  });

  it("returns 0 when worktreeDir is empty string (treated as omitted)", async () => {
    const projectDir = tempDirWithFiles(harness, [], "project-agents");
    tempDirWithFiles(harness, [
      { name: "wt-agent.md", content: makeAgentMd({ name: "wt-agent" }) },
    ], "worktree-agents");

    setAgentScanDirs("", projectDir);
    registerAgents(new Map());

    const count = await discoverNewAgents("");
    expect(count).toBe(0);
    expect(resolveType("wt-agent")).toBeUndefined();
  });

  it("does not duplicate agents already in the registry", async () => {
    const projectDir = tempDirWithFiles(harness, [
      { name: "shared.md", content: makeAgentMd({ name: "shared", description: "From project" }) },
    ], "project-agents");
    const worktreeDir = tempDirWithFiles(harness, [
      { name: "wt-shared.md", content: makeAgentMd({ name: "shared", description: "From worktree" }) },
    ], "worktree-agents");

    setAgentScanDirs("", projectDir);
    registerAgents(new Map());

    // First discovery — project agent gets added
    await discoverNewAgents();
    expect(getAgentConfig("shared")?.description).toBe("From project");

    // Second discovery with worktree — should NOT override the already-registered agent
    const count = await discoverNewAgents(worktreeDir);
    expect(count).toBe(0); // "shared" is already known
    expect(getAgentConfig("shared")?.description).toBe("From project");
  });
});

describe("discoverNewAgents - disableDefaultAgents", () => {
  beforeEach(() => {
    registerAgents(new Map());
    setAgentScanDirs("", "");
  });

  it("preserves the session policy while discovering a custom agent", async () => {
    const projectDir = tempDirWithFiles(harness, [
      { name: "custom.md", content: makeAgentMd({ name: "custom", description: "Custom" }) },
    ], "project-agents");

    setAgentScanDirs("", projectDir, true);
    registerAgents(new Map(), { disableDefaultAgents: true });

    await discoverNewAgents();

    expect(getAvailableTypes()).toEqual(["custom"]);
  });
});
