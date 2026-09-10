/**
 * Verify root-relative documentation and Agent Note paths in codebase source files.
 * Ported from deepseek-ai/deepseek-harness: scripts/verify-doc-refs.ts
 *
 * Scans source comments and string literals for `.agents/notes/.../*.md` and `docs/.../*.md`.
 * Ensures any referenced Agent Note or documentation actually exists in the repository,
 * preventing stale anchors, dead references, and drift when notes are renamed or archived.
 *
 * Usage: npx tsx scripts/verify-doc-refs.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

// Find repository root by locating .git or walking up from current directory
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

/** Source file extensions to scan for reverse-anchor documentation comments */
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".c", ".cpp",
  ".h", ".hpp", ".cs", ".rb", ".php", ".swift",
  ".kt", ".scala", ".sh", ".bash", ".zsh",
]);

/** Directories to ignore during scanning */
const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "lib", "out",
  "vendor", ".venv", "venv", "target", "coverage", ".cache",
  ".github", "assets",
]);

/** Root-relative Agent Note and doc path pattern */
const DOC_REF_REGEX = /(?:\.agents\/notes|docs)\/[A-Za-z0-9._/-]+\.md/g;

interface ReferenceViolation {
  file: string;
  line: number;
  ref: string;
}

function scanDirectory(dir: string, fileList: string[] = []): string[] {
  if (!existsSync(dir)) return fileList;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return fileList;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        scanDirectory(fullPath, fileList);
      }
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (SOURCE_EXTENSIONS.has(ext)) {
        fileList.push(fullPath);
      }
    }
  }

  return fileList;
}

const allSourceFiles = scanDirectory(repoRoot);
const violations: ReferenceViolation[] = [];

for (const filePath of allSourceFiles) {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    continue;
  }

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match: RegExpExecArray | null;
    DOC_REF_REGEX.lastIndex = 0;

    while ((match = DOC_REF_REGEX.exec(line)) !== null) {
      const refPath = match[0];
      // Skip markdown placeholder ellipses like `...`
      if (refPath.includes("…") || refPath.includes("<") || refPath.includes(">")) {
        continue;
      }

      const targetFullPath = resolve(repoRoot, refPath);
      if (!existsSync(targetFullPath)) {
        violations.push({
          file: relative(repoRoot, filePath).replace(/\\/g, "/"),
          line: i + 1,
          ref: refPath,
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("verify-doc-refs: broken documentation / Agent Note references found in source code (target does not exist):");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} -> ${v.ref}`);
  }
  console.error(`\nFailed: found ${violations.length} broken reference(s). Please update or restore the corresponding Agent Note.`);
  process.exit(1);
}

console.log(`ok: verify-doc-refs checked ${allSourceFiles.length} source file(s), all Agent Note references resolve.`);
