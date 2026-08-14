import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

export interface SourceImport {
  readonly source: string;
  readonly specifier: string;
  readonly target?: string;
}

/**
 * A module reference whose target cannot be decided by reading the file. The
 * graph must report these instead of ignoring them: an edge the collector
 * cannot see is an edge the cycle and direction guards silently approve, which
 * is the failure mode that lets a computed specifier reintroduce a cycle while
 * every architecture test stays green.
 */
export interface OpaqueModuleReference {
  readonly source: string;
  readonly kind: "computed-import" | "computed-require";
  readonly text: string;
}

export interface SourceGraph {
  readonly files: readonly string[];
  readonly imports: readonly SourceImport[];
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly opaqueReferences: readonly OpaqueModuleReference[];
}

export interface ModuleReferences {
  readonly specifiers: readonly string[];
  readonly opaque: readonly Omit<OpaqueModuleReference, "source">[];
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

function literalText(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function isRequireCall(node: ts.CallExpression): boolean {
  return ts.isIdentifier(node.expression) && node.expression.text === "require";
}

/**
 * Every way this codebase can name another module: static import and export,
 * dynamic `import()`, and `require()`. The last two accept expressions, so each
 * one is either a literal specifier or an opaque reference — never dropped.
 */
export function analyzeModuleReferences(sourceText: string, fileName: string): ModuleReferences {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const opaque: Array<Omit<OpaqueModuleReference, "source">> = [];
  const add = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const required = isRequireCall(node);
      if (dynamic || required) {
        const literal = literalText(node.arguments[0]);
        if (literal !== undefined) specifiers.push(literal);
        else {
          opaque.push({
            kind: dynamic ? "computed-import" : "computed-require",
            text: node.getText().replace(/\s+/g, " ").slice(0, 120),
          });
        }
      }
    }
    ts.forEachChild(node, add);
  };
  add(sourceFile);
  return { specifiers, opaque };
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
  const opaqueReferences: OpaqueModuleReference[] = [];

  for (const source of files) {
    const sourcePath = relativeSourcePath(projectRoot, source);
    const sourceText = readFileSync(source, "utf8");
    edges.set(sourcePath, new Set());
    const references = analyzeModuleReferences(sourceText, source);
    for (const specifier of references.specifiers) {
      const target = resolveRelativeImport(source, specifier, sourceFiles);
      const targetPath = target ? relativeSourcePath(projectRoot, target) : undefined;
      imports.push({ source: sourcePath, specifier, target: targetPath });
      if (targetPath) edges.get(sourcePath)!.add(targetPath);
    }
    for (const reference of references.opaque) {
      opaqueReferences.push({ source: sourcePath, ...reference });
    }
  }

  return {
    files: files.map((file) => relativeSourcePath(projectRoot, file)),
    imports,
    edges,
    opaqueReferences,
  };
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
