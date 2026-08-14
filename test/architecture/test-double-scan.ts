import ts from "typescript";

/**
 * Which module a test replaces, decided from syntax rather than from a text
 * pattern. The earlier regex scanner only understood two spellings, so
 * `vi.mock(import("../../src/x.js"))`, a template-literal specifier, or a spy on
 * an aliased namespace all passed while doing the forbidden thing. A scanner
 * that cannot decide a target must say so instead of staying quiet, which is why
 * unresolved targets are reported as violations too.
 */
export type TestDoubleFinding =
  | { readonly kind: "internal-mock"; readonly specifier: string }
  | { readonly kind: "internal-namespace-spy"; readonly binding: string }
  | { readonly kind: "undecidable-mock"; readonly text: string };

function isInternalSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.includes("/src/");
}

function literalSpecifier(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/** `import("x")`, `await import("x")`, `vi.importActual("x")`, `require("x")`. */
function moduleLoadSpecifier(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isAwaitExpression(node)) return moduleLoadSpecifier(node.expression);
  if (ts.isParenthesizedExpression(node)) return moduleLoadSpecifier(node.expression);
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
  const isImportHelper = ts.isPropertyAccessExpression(callee)
    && /^importActual|importMock$/.test(callee.name.text);
  const isRequire = ts.isIdentifier(callee) && callee.text === "require";
  if (!isDynamicImport && !isImportHelper && !isRequire) return undefined;
  return literalSpecifier(node.arguments[0]);
}

function mockCallName(node: ts.CallExpression): string | undefined {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  return callee.name.text === "mock" || callee.name.text === "doMock" ? callee.name.text : undefined;
}

export function scanTestDoubles(sourceText: string, fileName: string): TestDoubleFinding[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const findings: TestDoubleFinding[] = [];
  const internalBindings = new Set<string>();

  const collectBindings = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause?.namedBindings;
      if (clause && ts.isNamespaceImport(clause) && isInternalSpecifier(node.moduleSpecifier.text)) {
        internalBindings.add(clause.name.text);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const loaded = moduleLoadSpecifier(node.initializer);
      if (loaded !== undefined && isInternalSpecifier(loaded)) internalBindings.add(node.name.text);
      else if (ts.isIdentifier(node.initializer) && internalBindings.has(node.initializer.text)) {
        internalBindings.add(node.name.text);
      }
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (mockCallName(node)) {
        const [target] = node.arguments;
        const specifier = literalSpecifier(target) ?? moduleLoadSpecifier(target);
        if (specifier === undefined) {
          findings.push({ kind: "undecidable-mock", text: node.getText().replace(/\s+/g, " ").slice(0, 120) });
        } else if (isInternalSpecifier(specifier)) {
          findings.push({ kind: "internal-mock", specifier });
        }
      }
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "spyOn") {
        const [subject] = node.arguments;
        if (subject && ts.isIdentifier(subject) && internalBindings.has(subject.text)) {
          findings.push({ kind: "internal-namespace-spy", binding: subject.text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}
