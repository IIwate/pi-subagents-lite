import ts from "typescript";

/**
 * Which module a test replaces, decided from syntax rather than from a text
 * pattern. The earlier regex scanner only understood two spellings, so
 * `vi.mock(import("../../src/x.js"))`, a template-literal specifier, or a spy on
 * an aliased namespace all passed while doing the forbidden thing. A scanner
 * that cannot decide a target must say so instead of staying quiet, which is why
 * unresolved targets are reported as violations too.
 *
 * Element access (`vi["mock"]`, `vi[x]`), a mock binding taken off `vi`, and
 * spies through `await import` / `as` / `!` are the same replacement wearing
 * a different coat. Computed keys that might be mock/doMock are undecidable
 * rather than ignored. Destructured `mock` from anything other than `vi` is
 * left alone — that alias is too cheap to be sure.
 */

export type TestDoubleFinding =
  | { readonly kind: "internal-mock"; readonly specifier: string }
  | { readonly kind: "internal-namespace-spy"; readonly binding: string }
  | { readonly kind: "undecidable-mock"; readonly text: string };

const MOCK_METHODS = new Set(["mock", "doMock"]);

function isInternalSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.includes("/src/");
}

function literalSpecifier(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (true) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else if (ts.isAwaitExpression(current)) current = current.expression;
    else break;
  }
  return current;
}

function isViIdentifier(node: ts.Expression): boolean {
  const current = unwrapExpression(node);
  return ts.isIdentifier(current) && current.text === "vi";
}

/** `import("x")`, `await import("x")`, `vi.importActual("x")`, `require("x")`. */
function moduleLoadSpecifier(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  const current = unwrapExpression(node);
  if (!ts.isCallExpression(current)) return undefined;
  const callee = current.expression;
  const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
  const isImportHelper = ts.isPropertyAccessExpression(callee)
    && /^importActual|importMock$/.test(callee.name.text);
  const isRequire = ts.isIdentifier(callee) && callee.text === "require";
  if (!isDynamicImport && !isImportHelper && !isRequire) return undefined;
  return literalSpecifier(current.arguments[0]);
}

function bindingName(element: ts.BindingElement): { property: string; local: string } | undefined {
  if (element.dotDotDotToken || !ts.isIdentifier(element.name)) return undefined;
  const property = element.propertyName && ts.isIdentifier(element.propertyName)
    ? element.propertyName.text
    : element.name.text;
  return { property, local: element.name.text };
}

function mockCallKind(node: ts.CallExpression, viMockBindings: ReadonlySet<string>): "mock" | "undecidable" | undefined {
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee) && MOCK_METHODS.has(callee.name.text)) return "mock";
  if (ts.isElementAccessExpression(callee) && isViIdentifier(callee.expression)) {
    const key = literalSpecifier(callee.argumentExpression);
    if (key !== undefined) return MOCK_METHODS.has(key) ? "mock" : undefined;
    return "undecidable";
  }
  if (ts.isIdentifier(callee) && viMockBindings.has(callee.text)) return "mock";
  return undefined;
}

export function scanTestDoubles(sourceText: string, fileName: string): TestDoubleFinding[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const findings: TestDoubleFinding[] = [];
  const internalBindings = new Set<string>();
  const viMockBindings = new Set<string>();

  const collectBindings = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause?.namedBindings;
      if (clause && ts.isNamespaceImport(clause) && isInternalSpecifier(node.moduleSpecifier.text)) {
        internalBindings.add(clause.name.text);
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isIdentifier(node.name)) {
        const loaded = moduleLoadSpecifier(node.initializer);
        if (loaded !== undefined && isInternalSpecifier(loaded)) internalBindings.add(node.name.text);
        else if (ts.isIdentifier(initializer) && internalBindings.has(initializer.text)) {
          internalBindings.add(node.name.text);
        } else if (
          ts.isPropertyAccessExpression(initializer)
          && isViIdentifier(initializer.expression)
          && MOCK_METHODS.has(initializer.name.text)
        ) {
          viMockBindings.add(node.name.text);
        }
      }
      if (ts.isObjectBindingPattern(node.name) && isViIdentifier(initializer)) {
        for (const element of node.name.elements) {
          const names = bindingName(element);
          if (names && MOCK_METHODS.has(names.property)) viMockBindings.add(names.local);
        }
      }
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const kind = mockCallKind(node, viMockBindings);
      if (kind === "undecidable") {
        findings.push({ kind: "undecidable-mock", text: node.getText().replace(/\s+/g, " ").slice(0, 120) });
      } else if (kind === "mock") {
        const [target] = node.arguments;
        const specifier = literalSpecifier(target) ?? moduleLoadSpecifier(target);
        if (specifier === undefined) {
          findings.push({ kind: "undecidable-mock", text: node.getText().replace(/\s+/g, " ").slice(0, 120) });
        } else if (isInternalSpecifier(specifier)) {
          findings.push({ kind: "internal-mock", specifier });
        }
      }
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "spyOn" && node.arguments[0]) {
        const subject = unwrapExpression(node.arguments[0]);
        if (ts.isIdentifier(subject) && internalBindings.has(subject.text)) {
          findings.push({ kind: "internal-namespace-spy", binding: subject.text });
        } else {
          const loaded = moduleLoadSpecifier(node.arguments[0]);
          if (loaded !== undefined && isInternalSpecifier(loaded)) {
            findings.push({ kind: "internal-namespace-spy", binding: loaded });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}
