import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { dependencyDirectionViolations } from "./architecture-rules.js";
import { collectSourceGraph, stronglyConnectedComponents } from "./source-graph.js";

const projectRoot = resolve(import.meta.dirname, "../..");

// These are migration baselines, not accepted architecture. A slice must remove
// a resolved entry and may never add a new one.
const legacyCycleBaseline = new Set([
  "src/agents/types.ts|src/types.ts",
  [
    "src/agents/agent-manager.ts",
    "src/agents/agent-runner.ts",
    "src/agents/tool-execution.ts",
    "src/config/config-store.ts",
    "src/shell.ts",
    "src/spawn/spawn-coordinator.ts",
    "src/ui/agent-navigator.ts",
  ].join("|"),
]);

const legacyInternalMockBaseline: Readonly<Record<string, number>> = {
  "test/events.test.ts": 4,
  "test/fixtures.ts": 3,
  "test/index.test.ts": 8,
  "test/menu-mock-setup.ts": 6,
  "test/agents/agent-manager.test.ts": 2,
  "test/agents/agent-runner.test.ts": 6,
  "test/agents/agent-status.test.ts": 1,
  "test/agents/queued-model-permission.integration.test.ts": 3,
  "test/agents/result-delivery.integration.test.ts": 2,
  "test/agents/stop-agent.test.ts": 5,
  "test/agents/tool-execution.test.ts": 4,
  "test/config/config-io-normalize.test.ts": 1,
  "test/prompt/prompts.test.ts": 1,
  "test/prompt/skill-loader.test.ts": 1,
  "test/spawn/session-fallback.integration.test.ts": 1,
  "test/spawn/spawn-coordinator.test.ts": 6,
  "test/spawn/worktree-validator.test.ts": 1,
  "test/ui/agent-navigator.test.ts": 1,
  "test/ui/menu/helpers.test.ts": 1,
  "test/ui/menu/menu-concurrency.test.ts": 2,
  "test/ui/menu/menu-debug.test.ts": 2,
  "test/ui/menu/menu-model-routing.test.ts": 2,
  "test/ui/menu/menu-spawn-options.test.ts": 1,
  "test/ui/menu/menu-system-prompt.test.ts": 1,
  "test/ui/menu/menu-widget-settings.test.ts": 1,
  "test/ui/menu/submenus/confirm.test.ts": 2,
  "test/ui/menu/submenus/numeric-input.test.ts": 1,
};

function internalMockCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        visit(path);
        continue;
      }
      if (!path.endsWith(".ts")) continue;
      const source = readFileSync(path, "utf8");
      const count = [...source.matchAll(/vi\.mock\s*\(/g)].length;
      if (count > 0) counts[path.slice(projectRoot.length + 1).replaceAll("\\", "/")] = count;
    }
  };
  visit(resolve(projectRoot, "test"));
  return counts;
}

describe("architecture migration guardrails", () => {
  it("does not introduce a source cycle beyond the recorded migration baseline", () => {
    const graph = collectSourceGraph(projectRoot);
    const newCycles = stronglyConnectedComponents(graph).filter((cycle) => !legacyCycleBaseline.has(cycle));
    expect(newCycles).toEqual([]);
  });

  it("does not add internal module mocks beyond the recorded migration baseline", () => {
    expect(internalMockCounts()).toEqual(legacyInternalMockBaseline);
  });

  it("keeps target module imports behind public surfaces and inward layers", () => {
    const graph = collectSourceGraph(projectRoot);
    expect(dependencyDirectionViolations(graph)).toEqual([]);
  });
});
