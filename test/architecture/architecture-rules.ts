import type { SourceGraph } from "./source-graph.js";

function moduleName(path: string): string | undefined {
  const match = /^src\/modules\/([^/]+)\//.exec(path);
  return match?.[1];
}

function moduleLayer(path: string): string | undefined {
  const match = /^src\/modules\/[^/]+\/([^/]+)\//.exec(path);
  return match?.[1];
}

export function dependencyDirectionViolations(graph: SourceGraph): string[] {
  const violations: string[] = [];
  for (const source of graph.files) {
    const sourceModule = moduleName(source);
    const sourceLayer = moduleLayer(source);
    for (const entry of graph.imports.filter((item) => item.source === source)) {
      const targetModule = entry.target ? moduleName(entry.target) : undefined;
      if (sourceModule && targetModule && sourceModule !== targetModule && !entry.target!.endsWith(`/public.ts`)) {
        violations.push(`${source} imports ${entry.target} instead of ${targetModule}/public.ts`);
      }
      if (!sourceModule || !sourceLayer || !["contracts", "core", "application"].includes(sourceLayer)) continue;
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
