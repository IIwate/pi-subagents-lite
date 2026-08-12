import type { SourceGraph } from "./source-graph.js";

function moduleName(path: string): string | undefined {
  const match = /^src\/modules\/([^/]+)\//.exec(path);
  return match?.[1];
}

function moduleLayer(path: string): string | undefined {
  const match = /^src\/modules\/[^/]+\/([^/]+)\//.exec(path);
  return match?.[1];
}

const allowedInternalDependencies: Readonly<Record<string, ReadonlySet<string>>> = {
  contracts: new Set(),
  core: new Set(["contracts"]),
  ports: new Set(["contracts"]),
  application: new Set(["contracts", "core", "ports"]),
};

export function dependencyDirectionViolations(graph: SourceGraph): string[] {
  const violations: string[] = [];
  for (const source of graph.files) {
    const sourceModule = moduleName(source);
    const sourceLayer = moduleLayer(source);
    for (const entry of graph.imports.filter((item) => item.source === source)) {
      const targetModule = entry.target ? moduleName(entry.target) : undefined;
      const targetLayer = entry.target ? moduleLayer(entry.target) : undefined;
      if (targetModule && sourceModule !== targetModule && !entry.target!.endsWith(`/public.ts`)) {
        violations.push(`${source} imports ${entry.target} instead of ${targetModule}/public.ts`);
      }
      if (
        sourceModule
        && sourceModule === targetModule
        && sourceLayer
        && targetLayer
        && sourceLayer !== targetLayer
        && allowedInternalDependencies[sourceLayer]
        && !allowedInternalDependencies[sourceLayer].has(targetLayer)
      ) {
        violations.push(`${source} imports reverse layer ${entry.target}`);
      }
      if (!sourceModule || !sourceLayer || !["contracts", "core", "ports", "application"].includes(sourceLayer)) continue;
      const outwardPackage = entry.specifier.startsWith("node:") || entry.specifier.startsWith("@earendil-works/pi");
      const outwardPath = entry.target?.startsWith("src/platform/")
        || entry.target?.startsWith("src/adapters/")
        || entry.target?.startsWith("src/ui/")
        || entry.target?.startsWith("src/shell.ts");
      if (outwardPackage || outwardPath) {
        violations.push(`${source} imports outward dependency ${entry.specifier}`);
      }
    }
  }
  return violations.sort();
}
