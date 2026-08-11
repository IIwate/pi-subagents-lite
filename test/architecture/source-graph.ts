import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

export interface SourceImport {
  readonly source: string;
  readonly specifier: string;
  readonly target?: string;
}

export interface SourceGraph {
  readonly files: readonly string[];
  readonly imports: readonly SourceImport[];
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
}

function collectTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...collectTypeScriptFiles(path));
    } else if (extname(path) === ".ts") {
      files.push(resolve(path));
    }
  }
  return files.sort();
}

function moduleSpecifiers(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const result: string[] = [];
  const add = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) result.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteral(argument)) result.push(argument.text);
    }
    ts.forEachChild(node, add);
  };
  add(sourceFile);
  return result;
}

function resolveRelativeImport(sourceFile: string, specifier: string, sourceFiles: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const raw = resolve(dirname(sourceFile), specifier);
  const candidates = [
    raw,
    raw.replace(/\.js$/, ".ts"),
    `${raw}.ts`,
    join(raw, "index.ts"),
  ];
  return candidates.find((candidate) => sourceFiles.has(candidate));
}

function relativeSourcePath(projectRoot: string, fileName: string): string {
  return relative(projectRoot, fileName).replace(/\\/g, "/");
}

export function collectSourceGraph(projectRoot: string): SourceGraph {
  const sourceDirectory = resolve(projectRoot, "src");
  const files = collectTypeScriptFiles(sourceDirectory);
  const sourceFiles = new Set(files);
  const imports: SourceImport[] = [];
  const edges = new Map<string, Set<string>>();

  for (const source of files) {
    const sourcePath = relativeSourcePath(projectRoot, source);
    const sourceText = readFileSync(source, "utf8");
    edges.set(sourcePath, new Set());
    for (const specifier of moduleSpecifiers(sourceText, source)) {
      const target = resolveRelativeImport(source, specifier, sourceFiles);
      const targetPath = target ? relativeSourcePath(projectRoot, target) : undefined;
      imports.push({ source: sourcePath, specifier, target: targetPath });
      if (targetPath) edges.get(sourcePath)!.add(targetPath);
    }
  }

  return { files: files.map((file) => relativeSourcePath(projectRoot, file)), imports, edges };
}

export function stronglyConnectedComponents(graph: SourceGraph): string[] {
  let sequence = 0;
  const discovered = new Map<string, number>();
  const lowest = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[] = [];

  const visit = (source: string): void => {
    discovered.set(source, sequence);
    lowest.set(source, sequence);
    sequence += 1;
    stack.push(source);
    onStack.add(source);

    for (const target of graph.edges.get(source) ?? []) {
      if (!discovered.has(target)) {
        visit(target);
        lowest.set(source, Math.min(lowest.get(source)!, lowest.get(target)!));
      } else if (onStack.has(target)) {
        lowest.set(source, Math.min(lowest.get(source)!, discovered.get(target)!));
      }
    }

    if (lowest.get(source) !== discovered.get(source)) return;
    const component: string[] = [];
    do {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (component[component.length - 1] !== source);

    if (component.length > 1 || graph.edges.get(source)?.has(source)) {
      components.push(component.sort().join("|"));
    }
  };

  for (const source of graph.files) {
    if (!discovered.has(source)) visit(source);
  }
  return components.sort();
}
