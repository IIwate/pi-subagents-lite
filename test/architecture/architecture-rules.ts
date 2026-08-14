import type { SourceGraph } from "./source-graph.js";

/**
 * The declared layers, covering every file under `src/`. "shared" is not a
 * leftover bucket: it is the host-agnostic kernel (shared types, pure helpers,
 * agent policy and the activation-scoped registry) that adapters and the
 * composition root both need, and it is held to the same inward rules as a
 * module — no host packages, no adapters, no composition root. Anything outside
 * the four known directories lands here, so a new top-level directory inherits
 * the strictest rules instead of escaping the matrix.
 */
export type SourceLayer = "module" | "shared" | "platform" | "bootstrap" | "entry";

const moduleLayers = ["contracts", "core", "ports", "application"] as const;

const allowedInternalDependencies: Readonly<Record<string, ReadonlySet<string>>> = {
  contracts: new Set(),
  core: new Set(["contracts"]),
  ports: new Set(["contracts"]),
  application: new Set(["contracts", "core", "ports"]),
};

/** Which layers each layer may reach, in the one direction dependencies point. */
const allowedTargetLayers: Readonly<Record<SourceLayer, ReadonlySet<SourceLayer>>> = {
  module: new Set<SourceLayer>(["module"]),
  shared: new Set<SourceLayer>(["module", "shared"]),
  platform: new Set<SourceLayer>(["module", "shared", "platform"]),
  bootstrap: new Set<SourceLayer>(["module", "shared", "platform", "bootstrap"]),
  entry: new Set<SourceLayer>(["module", "shared", "platform", "bootstrap"]),
};

/** The only external packages the inward layers may name. */
const inwardPackages = new Set(["typebox", "typebox/value"]);

export function sourceLayer(path: string): SourceLayer {
  if (path.startsWith("src/modules/")) return "module";
  if (path.startsWith("src/platform/")) return "platform";
  if (path.startsWith("src/bootstrap/")) return "bootstrap";
  if (path === "src/index.ts") return "entry";
  return "shared";
}

function moduleName(path: string): string | undefined {
  const match = /^src\/modules\/([^/]+)\//.exec(path);
  return match?.[1];
}

function moduleLayer(path: string): string | undefined {
  const match = /^src\/modules\/[^/]+\/([^/]+)\//.exec(path);
  const layer = match?.[1];
  return layer && (moduleLayers as readonly string[]).includes(layer) ? layer : undefined;
}

/**
 * Only the module root counts as a facade. A nested `public.ts` would otherwise
 * launder a deep import into a legal-looking one.
 */
function isModuleFacade(path: string, module: string): boolean {
  return path === `src/modules/${module}/public.ts`;
}

/** In-repo direction: layer matrix, module facades, and intra-module layering. */
export function dependencyDirectionViolations(graph: SourceGraph): string[] {
  const violations: string[] = [];
  for (const source of graph.files) {
    const sourceModule = moduleName(source);
    const sourceModuleLayer = moduleLayer(source);
    const layer = sourceLayer(source);
    for (const entry of graph.imports.filter((item) => item.source === source)) {
      if (!entry.target) {
        if (entry.specifier.startsWith(".")) {
          violations.push(`${source} imports unresolved relative path ${entry.specifier}`);
        }
        continue;
      }
      const targetModule = moduleName(entry.target);
      const targetModuleLayer = moduleLayer(entry.target);

      if (targetModule && sourceModule !== targetModule && !isModuleFacade(entry.target, targetModule)) {
        violations.push(`${source} imports ${entry.target} instead of ${targetModule}/public.ts`);
      }

      if (sourceModule && isModuleFacade(source, sourceModule) && targetModule !== sourceModule) {
        violations.push(`${source} re-exports foreign module ${entry.target}`);
      }

      if (
        sourceModule
        && sourceModule === targetModule
        && sourceModuleLayer
        && targetModuleLayer
        && sourceModuleLayer !== targetModuleLayer
        && allowedInternalDependencies[sourceModuleLayer]
        && !allowedInternalDependencies[sourceModuleLayer].has(targetModuleLayer)
      ) {
        violations.push(`${source} imports reverse layer ${entry.target}`);
      }

      if (!allowedTargetLayers[layer].has(sourceLayer(entry.target))) {
        violations.push(`${source} imports outward layer ${entry.target}`);
      }
    }
  }
  return violations.sort();
}

export interface DeclaredDependencies {
  /** Packages this extension installs itself and may import at runtime. */
  readonly runtime: ReadonlySet<string>;
  /** Packages the host supplies at activation. */
  readonly host: ReadonlySet<string>;
}

/** `@scope/name/sub` and `name/sub` both name one installed package. */
function packageName(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

/**
 * External package placement. Pi TUI is a narrower seam than the rest of the
 * host: the replacement matrix promises that swapping it touches only the UI
 * adapter, so the package may not be named anywhere else — not even in the
 * composition root. Modules and the shared kernel get an allowlist rather than a
 * denylist, because the interesting failure is a vendor dependency nobody
 * thought to forbid. Every remaining package must be declared in the manifest:
 * an import that resolves only because a transitive install happens to hoist it
 * is a runtime failure waiting for a different install tree.
 */
export function externalPackageViolations(
  graph: SourceGraph,
  declared: DeclaredDependencies,
): string[] {
  const violations: string[] = [];
  for (const entry of graph.imports) {
    if (entry.target || entry.specifier.startsWith(".")) continue;
    if (entry.specifier.startsWith("node:")) {
      const layer = sourceLayer(entry.source);
      if (layer === "module" || layer === "shared") {
        violations.push(`${entry.source} imports platform API ${entry.specifier}`);
      }
      continue;
    }

    if (entry.specifier.startsWith("@earendil-works/pi-tui")) {
      if (!entry.source.startsWith("src/platform/pi/tui/")) {
        violations.push(`${entry.source} imports Pi TUI package ${entry.specifier}`);
      }
    } else if (sourceLayer(entry.source) === "module" || sourceLayer(entry.source) === "shared") {
      if (!inwardPackages.has(entry.specifier)) {
        violations.push(`${entry.source} imports outward dependency ${entry.specifier}`);
        continue;
      }
    }

    const name = packageName(entry.specifier);
    if (declared.runtime.has(name) || declared.host.has(name)) continue;
    violations.push(`${entry.source} imports undeclared package ${name}`);
  }
  return violations.sort();
}
