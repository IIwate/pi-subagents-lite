import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { dependencyDirectionViolations } from "./architecture-rules.js";
import { collectSourceGraph, stronglyConnectedComponents } from "./source-graph.js";

const projectRoot = resolve(import.meta.dirname, "../..");

function typescriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...typescriptFiles(path));
    else if (path.endsWith(".ts")) files.push(path);
  }
  return files;
}

function repoPath(path: string): string {
  return relative(projectRoot, path).replaceAll("\\", "/");
}

/**
 * vi.mock is allowed only against external packages (vendor seams with no
 * in-repo implementation to run instead). A relative specifier replaces one
 * of this repository's own modules and bypasses its public surface, so it is
 * a blocking violation — there is no baseline to ratchet anymore.
 */
function internalMockViolations(): string[] {
  const violations: string[] = [];
  for (const path of typescriptFiles(resolve(projectRoot, "test"))) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/vi\.mock\s*\(\s*["']([^"']+)["']/g)) {
      if (match[1].startsWith(".") || match[1].includes("/src/")) {
        violations.push(`${repoPath(path)} mocks internal module ${match[1]}`);
      }
    }
  }
  return violations;
}

/**
 * Cross-reload process state is confined to the one approved platform module:
 * Jiti reloads give each extension activation a fresh module registry, so
 * anything that must survive a reload lives behind that module's API. Any
 * other globalThis access reintroduces hidden shared state.
 */
function globalThisViolations(): string[] {
  const allowed = new Set(["src/platform/process/process-state.ts"]);
  const violations: string[] = [];
  for (const path of typescriptFiles(resolve(projectRoot, "src"))) {
    if (allowed.has(repoPath(path))) continue;
    const source = readFileSync(path, "utf8");
    if (/\bglobalThis\b/.test(source)) {
      violations.push(`${repoPath(path)} accesses globalThis`);
    }
  }
  return violations;
}

describe("architecture guards", () => {
  it("keeps the source dependency graph cycle-free", () => {
    const graph = collectSourceGraph(projectRoot);
    expect(stronglyConnectedComponents(graph)).toEqual([]);
  });

  it("forbids vi.mock of internal modules", () => {
    expect(internalMockViolations()).toEqual([]);
  });

  it("confines globalThis to the process-state platform module", () => {
    expect(globalThisViolations()).toEqual([]);
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
