import ts from "typescript";

/**
 * Requirement IDs are collected from executed describe/it/test titles, not
 * from comments or skipped calls. A regex over the file cannot tell those
 * apart: `// it("REQ-…")` and `it.skip("REQ-…")` both look like coverage.
 * Titles that are not string literals are left uncounted rather than guessed.
 */

const TEST_CALLEES = new Set(["describe", "it", "test"]);
const SKIPPED_MODIFIERS = new Set(["skip", "todo", "skipIf", "runIf", "fails"]);

function titleLiteral(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function rootTestCallee(expression: ts.Expression): { name: string; modifiers: string[] } | undefined {
  const modifiers: string[] = [];
  let current: ts.Expression = expression;

  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    modifiers.push(current.expression.name.text);
    current = current.expression.expression;
  }

  while (ts.isPropertyAccessExpression(current)) {
    modifiers.push(current.name.text);
    current = current.expression;
  }

  if (ts.isIdentifier(current) && TEST_CALLEES.has(current.text)) {
    return { name: current.text, modifiers };
  }
  if (ts.isIdentifier(current) && /^x(?:describe|it|test)$/.test(current.text)) {
    return { name: current.text.slice(1), modifiers: [...modifiers, "skip"] };
  }
  return undefined;
}

export function scanRequirementTags(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const tagged = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = rootTestCallee(node.expression);
      if (callee && !callee.modifiers.some((modifier) => SKIPPED_MODIFIERS.has(modifier))) {
        const title = titleLiteral(node.arguments[0]);
        if (title !== undefined) {
          for (const id of title.matchAll(/REQ-[A-Z]+-\d+/g)) tagged.add(id[0]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...tagged].sort();
}
