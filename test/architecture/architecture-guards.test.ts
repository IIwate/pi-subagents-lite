import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  dependencyDirectionViolations,
  externalPackageViolations,
  type DeclaredDependencies,
} from "./architecture-rules.js";
import { analyzeModuleReferences, collectSourceGraph, stronglyConnectedComponents } from "./source-graph.js";
import { scanTestDoubles } from "./test-double-scan.js";

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

function declaredDependencies(): DeclaredDependencies {
  const manifest = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  return {
    runtime: new Set(Object.keys(manifest.dependencies ?? {})),
    host: new Set(Object.keys(manifest.peerDependencies ?? {})),
  };
}

/**
 * Module replacement is allowed only against external packages (vendor seams
 * with no in-repo implementation to run instead). Replacing one of this
 * repository's own modules bypasses its public surface, so it is a blocking
 * violation — there is no baseline to ratchet anymore.
 */
function internalMockViolations(): string[] {
  const violations: string[] = [];
  for (const path of typescriptFiles(resolve(projectRoot, "test"))) {
    for (const finding of scanTestDoubles(readFileSync(path, "utf8"), path)) {
      if (finding.kind === "internal-mock") {
        violations.push(`${repoPath(path)} mocks internal module ${finding.specifier}`);
      } else if (finding.kind === "internal-namespace-spy") {
        violations.push(`${repoPath(path)} spies on internal module namespace ${finding.binding}`);
      } else {
        violations.push(`${repoPath(path)} mocks an undecidable target ${finding.text}`);
      }
    }
  }
  return violations.sort();
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
  return violations.sort();
}

describe("architecture guards", () => {
  // Tarjan over ~140 files is fast, but a cold TypeScript parse of every source
  // file is not: the earlier default timeout failed on a cold cache rather than
  // on a cycle, which is the kind of red that gets rerun instead of read.
  it("keeps the source dependency graph cycle-free", () => {
    const graph = collectSourceGraph(projectRoot);
    expect(stronglyConnectedComponents(graph)).toEqual([]);
  }, 30_000);

  it("names every module reference in a form the graph can resolve", () => {
    const graph = collectSourceGraph(projectRoot);
    expect(graph.opaqueReferences).toEqual([]);
  }, 30_000);

  it("reports computed imports and requires as opaque references", () => {
    const analysis = analyzeModuleReferences(
      [
        "const name = './generated.js';",
        "const a = await import(name);",
        "const b = require(`../${name}`);",
        "const c = require('./static.js');",
        "const d = await import(`./literal.js`);",
      ].join("\n"),
      "fixture.ts",
    );
    expect(analysis.specifiers).toEqual(["./static.js", "./literal.js"]);
    expect(analysis.opaque.map((entry) => entry.kind)).toEqual(["computed-import", "computed-require"]);
  });

  it("forbids replacing internal modules with mocks or namespace spies", () => {
    expect(internalMockViolations()).toEqual([]);
  });

  it("detects every spelling that replaces an internal module", () => {
    const findings = scanTestDoubles(
      [
        "import * as registry from '../../src/agents/agent-registry.js';",
        "const alias = registry;",
        "vi.mock('../../src/utils.js');",
        "vi.mock(import('../../src/types.js'));",
        "vi.doMock(`../../src/status-note.js`);",
        "vi.mock('@earendil-works/pi-coding-agent');",
        "vi.spyOn(alias, 'createAgentRegistry');",
        "const loaded = await import('../../src/utils.js');",
        "vi.spyOn(loaded, 'errorMessage');",
        "vi.mock(specifierFromVariable);",
      ].join("\n"),
      "fixture.test.ts",
    );
    expect(findings).toEqual([
      { kind: "internal-mock", specifier: "../../src/utils.js" },
      { kind: "internal-mock", specifier: "../../src/types.js" },
      { kind: "internal-mock", specifier: "../../src/status-note.js" },
      { kind: "internal-namespace-spy", binding: "alias" },
      { kind: "internal-namespace-spy", binding: "loaded" },
      { kind: "undecidable-mock", text: "vi.mock(specifierFromVariable)" },
    ]);
  });

  it("confines globalThis to the process-state platform module", () => {
    expect(globalThisViolations()).toEqual([]);
  });

  it("keeps target module imports behind public surfaces and inward layers", () => {
    const graph = collectSourceGraph(projectRoot);
    expect(dependencyDirectionViolations(graph)).toEqual([]);
  }, 30_000);

  it("keeps external packages inside their declared seams", () => {
    const graph = collectSourceGraph(projectRoot);
    expect(externalPackageViolations(graph, declaredDependencies())).toEqual([]);
  }, 30_000);

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
      opaqueReferences: [],
    })).toEqual([
      "src/modules/example/contracts/request.ts imports reverse layer src/modules/example/core/decision.ts",
      "src/modules/example/core/decision.ts imports reverse layer src/modules/example/application/execute.ts",
      "src/modules/example/ports/repository.ts imports reverse layer src/modules/example/application/execute.ts",
    ]);
  });

  it("rejects inward layers that reach the host, the adapters, or the composition root", () => {
    expect(dependencyDirectionViolations({
      files: [
        "src/modules/example/application/execute.ts",
        "src/utils.ts",
        "src/platform/fs/adapter.ts",
        "src/bootstrap/wiring.ts",
      ],
      imports: [
        {
          source: "src/modules/example/application/execute.ts",
          specifier: "../../../platform/fs/adapter.js",
          target: "src/platform/fs/adapter.ts",
        },
        {
          source: "src/utils.ts",
          specifier: "./bootstrap/wiring.js",
          target: "src/bootstrap/wiring.ts",
        },
        {
          source: "src/platform/fs/adapter.ts",
          specifier: "../../bootstrap/wiring.js",
          target: "src/bootstrap/wiring.ts",
        },
      ],
      edges: new Map(),
      opaqueReferences: [],
    })).toEqual([
      "src/modules/example/application/execute.ts imports outward layer src/platform/fs/adapter.ts",
      "src/platform/fs/adapter.ts imports outward layer src/bootstrap/wiring.ts",
      "src/utils.ts imports outward layer src/bootstrap/wiring.ts",
    ]);
  });

  it("rejects external consumers that bypass a module public surface, including a nested facade", () => {
    expect(dependencyDirectionViolations({
      files: [
        "src/platform/fs/adapter.ts",
        "src/bootstrap/wiring.ts",
        "src/modules/example/contracts/request.ts",
        "src/modules/example/core/public.ts",
      ],
      imports: [
        {
          source: "src/platform/fs/adapter.ts",
          specifier: "../../modules/example/contracts/request.js",
          target: "src/modules/example/contracts/request.ts",
        },
        {
          source: "src/bootstrap/wiring.ts",
          specifier: "../modules/example/core/public.js",
          target: "src/modules/example/core/public.ts",
        },
      ],
      edges: new Map(),
      opaqueReferences: [],
    })).toEqual([
      "src/bootstrap/wiring.ts imports src/modules/example/core/public.ts instead of example/public.ts",
      "src/platform/fs/adapter.ts imports src/modules/example/contracts/request.ts instead of example/public.ts",
    ]);
  });

  it("rejects packages outside their declared seam", () => {
    const declared: DeclaredDependencies = {
      runtime: new Set(["typebox"]),
      host: new Set(["@earendil-works/pi-tui", "@earendil-works/pi-coding-agent"]),
    };
    expect(externalPackageViolations({
      files: [
        "src/modules/example/ports/repository.ts",
        "src/bootstrap/wiring.ts",
        "src/platform/pi/tui/screen.ts",
      ],
      imports: [
        { source: "src/modules/example/ports/repository.ts", specifier: "node:fs" },
        { source: "src/modules/example/ports/repository.ts", specifier: "@earendil-works/pi-coding-agent" },
        { source: "src/bootstrap/wiring.ts", specifier: "@earendil-works/pi-tui" },
        { source: "src/bootstrap/wiring.ts", specifier: "lodash" },
        { source: "src/platform/pi/tui/screen.ts", specifier: "@earendil-works/pi-tui" },
      ],
      edges: new Map(),
      opaqueReferences: [],
    }, declared)).toEqual([
      "src/bootstrap/wiring.ts imports Pi TUI package @earendil-works/pi-tui",
      "src/bootstrap/wiring.ts imports undeclared package lodash",
      "src/modules/example/ports/repository.ts imports outward dependency @earendil-works/pi-coding-agent",
      "src/modules/example/ports/repository.ts imports platform API node:fs",
    ]);
  });
});
