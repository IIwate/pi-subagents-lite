/**
 * Verify AST equivalence between canonical type declarations in Agent Notes and actual source code.
 * Ported and generalized from deepseek-ai/deepseek-harness: scripts/verify-type-equiv.ts
 *
 * Ensures architectural type contracts documented in Notes never drift from real implementations.
 *
 * Syntax in Markdown:
 *   ```ts type-equiv: <SymbolName> from <SourceFilePath>
 *   export interface SessionConfig {
 *     engine: string;
 *     wal: boolean;
 *   }
 *   ```
 * Or inline comment in first line of code block:
 *   ```ts type-equiv
 *   // type-equiv: <SymbolName> from <SourceFilePath>
 *   export interface SessionConfig { ... }
 *   ```
 *
 * Usage: npx tsx scripts/verify-type-equiv.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { agentNoteRoot } from "./agent-note-tree.ts";

function findRepoRoot(startDir: string): string {
  let cur = resolve(startDir);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(cur, ".git")) || existsSync(join(cur, ".agents", "notes"))) {
      return cur;
    }
    const parent = resolve(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }
  return resolve(process.cwd());
}

const repoRoot = findRepoRoot(process.cwd());

interface EquivBlock {
  docRel: string;
  line: number;
  symbol: string;
  sourceRel: string;
  code: string;
}

/** Get all markdown files in .agents/notes and docs */
function getMarkdownFiles(): string[] {
  const files: string[] = [];
  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git") {
          walk(full);
        }
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(full);
      }
    }
  }
  walk(agentNoteRoot);
  const docsDir = join(repoRoot, "docs");
  if (existsSync(docsDir)) {
    walk(docsDir);
  }
  return files;
}

/** Parse fence header like `ts type-equiv: SymbolName from path/to/source.ts` */
const FENCE_HEADER_REGEX = /^ts\s+type-equiv:\s*([A-Za-z0-9_]+)\s+from\s+([A-Za-z0-9_./-]+)/i;
const COMMENT_HEADER_REGEX = /^\/\/\s*type-equiv:\s*([A-Za-z0-9_]+)\s+from\s+([A-Za-z0-9_./-]+)/i;

function extractEquivBlocks(absPath: string): EquivBlock[] {
  const content = readFileSync(absPath, "utf8");
  const lines = content.split("\n");
  const blocks: EquivBlock[] = [];
  const docRel = relative(repoRoot, absPath).replace(/\\/g, "/");

  let inFence = false;
  let currentInfo = "";
  let currentLines: string[] = [];
  let fenceStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (!inFence) {
        inFence = true;
        currentInfo = trimmed.slice(3).trim();
        fenceStartLine = i + 1;
        currentLines = [];
      } else {
        inFence = false;
        // Check if fence is a type-equiv block
        let symbol = "";
        let sourceRel = "";

        const headerMatch = currentInfo.match(FENCE_HEADER_REGEX);
        if (headerMatch) {
          symbol = headerMatch[1];
          sourceRel = headerMatch[2];
        } else if (currentInfo.startsWith("ts type-equiv") && currentLines.length > 0) {
          const commentMatch = currentLines[0].trim().match(COMMENT_HEADER_REGEX);
          if (commentMatch) {
            symbol = commentMatch[1];
            sourceRel = commentMatch[2];
            // Remove the directive comment line for AST comparison
            currentLines.shift();
          }
        }

        if (symbol && sourceRel) {
          blocks.push({
            docRel,
            line: fenceStartLine,
            symbol,
            sourceRel,
            code: currentLines.join("\n"),
          });
        }

        currentInfo = "";
        currentLines = [];
      }
    } else if (inFence) {
      currentLines.push(line);
    }
  }

  return blocks;
}

/** Normalize code text for robust structure comparison */
function normalizeStructure(text: string): string {
  return text
    .replace(/^export\s+(default\s+)?/, "") // Strip leading export
    .replace(/\/\*[\s\S]*?\*\//g, "")      // Strip multi-line comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1")     // Strip single-line comments
    .replace(/\s+/g, " ")                   // Collapse whitespace
    .replace(/;\s*}/g, " }")                // Normalize trailing semicolon before brace
    .replace(/,\s*}/g, " }")                // Normalize trailing comma before brace
    .trim();
}

/** Extract declared node text for a given symbol from a TypeScript SourceFile */
function findDeclarationNodeText(sourceFile: ts.SourceFile, targetSymbol: string): string | null {
  let foundText: string | null = null;

  function visit(node: ts.Node) {
    if (foundText !== null) return;

    if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      if (node.name && node.name.text === targetSymbol) {
        foundText = node.getText(sourceFile);
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return foundText;
}

const mdFiles = getMarkdownFiles();
const allEquivBlocks: EquivBlock[] = [];

for (const f of mdFiles) {
  allEquivBlocks.push(...extractEquivBlocks(f));
}

if (allEquivBlocks.length === 0) {
  console.log(`ok: verify-type-equiv checked ${mdFiles.length} markdown file(s), 0 type-equiv fence(s) declared.`);
  process.exit(0);
}

let failures = 0;

for (const block of allEquivBlocks) {
  const sourceFullPath = resolve(repoRoot, block.sourceRel);
  if (!existsSync(sourceFullPath)) {
    console.error(`verify-type-equiv: ${block.docRel}:${block.line} - source file not found: ${block.sourceRel}`);
    failures++;
    continue;
  }

  let sourceContent: string;
  try {
    sourceContent = readFileSync(sourceFullPath, "utf8");
  } catch (err) {
    console.error(`verify-type-equiv: ${block.docRel}:${block.line} - cannot read source file ${block.sourceRel}:`, err);
    failures++;
    continue;
  }

  const docSourceFile = ts.createSourceFile("doc-block.ts", block.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const realSourceFile = ts.createSourceFile(block.sourceRel, sourceContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const docDeclaration = findDeclarationNodeText(docSourceFile, block.symbol);
  if (!docDeclaration) {
    console.error(`verify-type-equiv: ${block.docRel}:${block.line} - symbol "${block.symbol}" not found in doc fence declaration`);
    failures++;
    continue;
  }

  const realDeclaration = findDeclarationNodeText(realSourceFile, block.symbol);
  if (!realDeclaration) {
    console.error(`verify-type-equiv: ${block.docRel}:${block.line} - symbol "${block.symbol}" not found in source file "${block.sourceRel}"`);
    failures++;
    continue;
  }

  const normDoc = normalizeStructure(docDeclaration);
  const normReal = normalizeStructure(realDeclaration);

  if (normDoc !== normReal) {
    console.error(`verify-type-equiv: ${block.docRel}:${block.line} - AST divergence for symbol "${block.symbol}"!`);
    console.error(`  Expected (from ${block.sourceRel}):\n    ${realDeclaration.trim()}`);
    console.error(`  Actual in Note:\n    ${docDeclaration.trim()}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\nFailed: found ${failures} type equivalence mismatch(es). Please sync Agent Note declarations with source code.`);
  process.exit(1);
}

console.log(`ok: verify-type-equiv verified ${allEquivBlocks.length} canonical type declaration(s) across ${mdFiles.length} file(s).`);
