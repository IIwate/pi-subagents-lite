import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { dependencyDirectionViolations } from "./architecture-rules.js";
import { collectSourceGraph, stronglyConnectedComponents } from "./source-graph.js";

const projectRoot = resolve(import.meta.dirname, "../..");

// These are migration baselines, not accepted architecture. A slice must remove
// a resolved entry and may never add a new one.
const legacyCycleBaseline = new Set<string>();

const legacyInternalMockBaseline: Readonly<Record<string, number>> = {
  "test/events.test.ts": 4,
  "test/fixtures.ts": 3,
  "test/index.test.ts": 8,
  "test/menu-mock-setup.ts": 6,
  "test/agents/agent-runner.test.ts": 6,
  "test/agents/agent-status.test.ts": 1,
  "test/agents/queued-model-permission.integration.test.ts": 3,
  "test/agents/result-delivery.integration.test.ts": 2,
  "test/agents/stop-agent.test.ts": 5,
  "test/agents/tool-execution.test.ts": 4,
  "test/prompt/prompts.test.ts": 1,
  "test/prompt/skill-loader.test.ts": 1,
  "test/spawn/session-fallback.integration.test.ts": 1,
  "test/spawn/spawn-coordinator.test.ts": 6,

  "test/ui/menu/menu-model-routing.test.ts": 2,
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

  it("rejects reverse dependencies inside a capability module", () => {
    expect(dependencyDirectionViolations({
      files: [
        "src/modules/example/contracts/request.ts",
        "src/modules/example/core/decision.ts",
        "src/modules/example/application/execute.ts",
        "src/modules/example/ports/repository.ts",
      ],
      imports: [
        {
          source: "src/modules/example/contracts/request.ts",
          specifier: "../core/decision.js",
          target: "src/modules/example/core/decision.ts",
        },
        {
          source: "src/modules/example/core/decision.ts",
          specifier: "../application/execute.js",
          target: "src/modules/example/application/execute.ts",
        },
        {
          source: "src/modules/example/ports/repository.ts",
          specifier: "../application/execute.js",
          target: "src/modules/example/application/execute.ts",
        },
      ],
      edges: new Map(),
    })).toEqual([
      "src/modules/example/contracts/request.ts imports reverse layer src/modules/example/core/decision.ts",
      "src/modules/example/core/decision.ts imports reverse layer src/modules/example/application/execute.ts",
      "src/modules/example/ports/repository.ts imports reverse layer src/modules/example/application/execute.ts",
    ]);
  });

  it("rejects ports that depend on platform packages", () => {
    expect(dependencyDirectionViolations({
      files: ["src/modules/example/ports/repository.ts"],
      imports: [{
        source: "src/modules/example/ports/repository.ts",
        specifier: "node:fs",
      }],
      edges: new Map(),
    })).toEqual([
      "src/modules/example/ports/repository.ts imports outward dependency node:fs",
    ]);
  });

  it("rejects external consumers that bypass a module public surface", () => {
    expect(dependencyDirectionViolations({
      files: [
        "src/platform/fs/adapter.ts",
        "src/modules/example/contracts/request.ts",
      ],
      imports: [{
        source: "src/platform/fs/adapter.ts",
        specifier: "../../modules/example/contracts/request.js",
        target: "src/modules/example/contracts/request.ts",
      }],
      edges: new Map(),
    })).toEqual([
      "src/platform/fs/adapter.ts imports src/modules/example/contracts/request.ts instead of example/public.ts",
    ]);
  });
});
