/**
 * Verify TypeScript code fences in Agent Notes and documentation against real compiler diagnostics.
 * Ported and generalized from deepseek-ai/deepseek-harness: scripts/doc-typecheck.ts
 *
 * Rules:
 *   - ```ts / ```typescript: checked for type correctness against project tsconfig.
 *   - ```ts ignore-check: explicitly opted-out unchecked snippets (e.g. pseudocode, sketches).
 *   - ```ts type-equiv...: skipped here, verified by verify-type-equiv.ts.
 *
 * Usage: npx tsx scripts/verify-doc-typecheck.ts
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

interface CodeBlock {
  file: string;
  absPath: string;
  startLine: number;
  info: string;
  code: string;
}

/** Extract all markdown files under .agents/notes and docs (if any) */
function getMarkdownFiles(): string[] {
  const files: string[] = [];

  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git" && resolve(full) !== resolve(agentNoteRoot, "archived")) {
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

/** Extract code fences from a markdown file */
function extractFences(absPath: string): CodeBlock[] {
  const content = readFileSync(absPath, "utf8");
  const lines = content.split("\n");
  const blocks: CodeBlock[] = [];
  const relFile = relative(repoRoot, absPath).replace(/\\/g, "/");

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
        blocks.push({
          file: relFile,
          absPath,
          startLine: fenceStartLine,
          info: currentInfo,
          code: currentLines.join("\n"),
        });
        currentInfo = "";
        currentLines = [];
      }
    } else if (inFence) {
      currentLines.push(line);
    }
  }

  return blocks;
}

/** Load compiler options from tsconfig.json or use fallback defaults */
function getCompilerOptions(): ts.CompilerOptions {
  const tsconfigPath = join(repoRoot, "tsconfig.json");
  let options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
    allowJs: true,
  };

  if (existsSync(tsconfigPath)) {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (!configFile.error) {
      const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot);
      options = {
        ...parsed.options,
        noEmit: true,
        skipLibCheck: true,
        noUnusedLocals: false,
        noUnusedParameters: false,
      };
    }
  }

  return options;
}

const mdFiles = getMarkdownFiles();
const allBlocks: CodeBlock[] = [];

for (const f of mdFiles) {
  const fences = extractFences(f);
  for (const fence of fences) {
    const infoLower = fence.info.toLowerCase();
    // Only target ts / typescript fences
    if (infoLower === "ts" || infoLower === "typescript" || infoLower.startsWith("ts ") || infoLower.startsWith("typescript ")) {
      // Explicit opt-out
      if (infoLower.includes("ignore-check")) {
        continue;
      }
      // Handled separately by verify-type-equiv
      if (infoLower.includes("type-equiv") || infoLower.includes("public-api")) {
        continue;
      }
      allBlocks.push(fence);
    }
  }
}

if (allBlocks.length === 0) {
  console.log(`ok: doc-typecheck checked ${mdFiles.length} markdown file(s), 0 checked typescript fence(s).`);
  process.exit(0);
}

const options = getCompilerOptions();
const sources = new Map<string, string>();
const virtualToBlock = new Map<string, CodeBlock>();

for (let i = 0; i < allBlocks.length; i++) {
  const block = allBlocks[i];
  const virtualFileName = resolve(repoRoot, `.doc-typecheck-virtual-${i}.ts`);
  sources.set(virtualFileName, block.code);
  virtualToBlock.set(virtualFileName, block);
}

const defaultHost = ts.createCompilerHost(options, true);
const customHost: ts.CompilerHost = {
  ...defaultHost,
  fileExists(fileName) {
    const resolved = resolve(fileName);
    return sources.has(resolved) || defaultHost.fileExists(fileName);
  },
  readFile(fileName) {
    const resolved = resolve(fileName);
    if (sources.has(resolved)) return sources.get(resolved);
    return defaultHost.readFile(fileName);
  },
  getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) {
    const resolved = resolve(fileName);
    if (sources.has(resolved)) {
      return ts.createSourceFile(fileName, sources.get(resolved)!, languageVersion, true);
    }
    return defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  },
};

const rootNames = Array.from(sources.keys());
const program = ts.createProgram(rootNames, options, customHost);
const diagnostics = ts.getPreEmitDiagnostics(program);

let hasError = false;

for (const diag of diagnostics) {
  if (diag.category === ts.DiagnosticCategory.Error) {
    hasError = true;
    if (diag.file) {
      const block = virtualToBlock.get(resolve(diag.file.fileName));
      if (block) {
        const { line: errLine, character: errCol } = diag.file.getLineAndCharacterOfPosition(diag.start ?? 0);
        // Map back to original markdown file line
        const actualLine = block.startLine + errLine;
        const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
        console.error(`doc-typecheck: ${block.file}:${actualLine}:${errCol + 1} - ${message}`);
        continue;
      }
    }
    console.error(`doc-typecheck error: ${ts.flattenDiagnosticMessageText(diag.messageText, "\n")}`);
  }
}

if (hasError) {
  console.error(`\nFailed: typecheck errors found in documentation code snippets. Fix code blocks or mark \`\`\`ts ignore-check if intentional.`);
  process.exit(1);
}

console.log(`ok: doc-typecheck verified ${allBlocks.length} code fence(s) across ${mdFiles.length} markdown file(s).`);
