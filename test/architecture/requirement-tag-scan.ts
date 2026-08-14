import ts from "typescript";

/**
 * Requirement IDs are collected from executed describe/it/test titles, not
 * from comments or skipped calls. A regex over the file cannot tell those
 * apart: `// it("REQ-…")` and `it.skip("REQ-…")` both look like coverage.
 * An `it("REQ-…")` nested under `describe.skip` is the same non-coverage:
 * the title never runs. Titles that are not string literals are left
 * uncounted rather than guessed.
 *
 * A tagged title is still not acceptance. An empty `it("REQ-…")` with no
 * `expect(` would otherwise count as coverage for a contract nobody
 * checked. The body is walked as AST, not regex, so a comment containing
 * `expect(` cannot launder a title-only test. The expect is not required
 * to mention the same REQ — that would be parsing assertion meaning.
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

function skippedAncestor(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isCallExpression(current)) {
      const callee = rootTestCallee(current.expression);
      if (callee?.modifiers.some((modifier) => SKIPPED_MODIFIERS.has(modifier))) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

function isExpectCallee(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === "expect";
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression.text === "expect";
  }
  return false;
}

function containsExpect(node: ts.Node | undefined): boolean {
  if (!node) return false;
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(current) && isExpectCallee(current.expression)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

export function scanRequirementTags(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const tagged = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = rootTestCallee(node.expression);
      if (
        callee
        && !callee.modifiers.some((modifier) => SKIPPED_MODIFIERS.has(modifier))
        && !skippedAncestor(node)
        && containsExpect(node.arguments[1] ?? node)
      ) {
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
