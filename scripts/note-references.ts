import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { agentNoteRoot } from "./agent-note-tree.ts";

export const projectRoot = resolve(agentNoteRoot, "../..");
const ignored = new Set([".git", "node_modules", "dist", "build", "out", "vendor", ".venv", "venv", "target", "coverage", ".cache"]);
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt", ".scala", ".sh", ".bash", ".zsh"]);

export interface NoteReference {
  file: string;
  line: number;
  start: number;
  end: number;
  target: string;
  suffix: string;
  kind: "markdown" | "source";
  angled: boolean;
}

/** Resolve inline links and reference definitions; fenced code remains literal text. */
export function referencesIn(file: string, content: string): NoteReference[] {
  const refs: NoteReference[] = [];
  const markdown = extname(file) === ".md";
  let fence: string | undefined;
  let offset = 0;
  for (const [index, line] of content.split("\n").entries()) {
    const marker = markdown ? line.match(/^\s*(`{3,}|~{3,})(.*)$/) : undefined;
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    } else if (!fence) {
      const pattern = markdown
        ? /(?:!?\[[^\]\n]*\]\(|^\s*\[[^\]\n]+\]:\s*)(<[^>\n]+>|[^\s()]+)(?=\s|\)|$)/g
        : /((?:\.agents\/notes|docs)\/[^\r\n"'`<>]*?\.md)(?=$|[\s"'`#;,)\]])/g;
      for (const match of line.matchAll(pattern)) {
        const raw = match[1];
        const angled = raw.startsWith("<");
        const target = angled ? raw.slice(1, -1) : raw;
        if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target) || target.includes("…")) continue;
        const fragment = target.indexOf("#");
        const path = fragment < 0 ? target : target.slice(0, fragment);
        const start = offset + match.index! + match[0].lastIndexOf(raw);
        refs.push({ file, line: index + 1, start, end: start + raw.length,
          target: resolve(markdown ? dirname(file) : projectRoot, decodeURIComponent(path)),
          suffix: fragment < 0 ? "" : target.slice(fragment), kind: markdown ? "markdown" : "source", angled });
      }
    }
    offset += line.length + 1;
  }
  return refs;
}

export function collectReferences(): NoteReference[] {
  const refs: NoteReference[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name) && file !== resolve(agentNoteRoot, "archived") && file !== resolve(agentNoteRoot, "templates")
          && file !== resolve(projectRoot, ".agents/skills")) visit(file);
      } else if (entry.isFile() && (extname(file) === ".md" || sourceExtensions.has(extname(file)))) {
        refs.push(...referencesIn(file, readFileSync(file, "utf8")));
      }
    }
  }
  visit(projectRoot);
  return refs;
}

export function rewriteReferences(content: string, refs: NoteReference[], destination: string, targetFor: (ref: NoteReference) => string): string {
  for (const ref of [...refs].reverse()) {
    const target = targetFor(ref);
    if (destination === ref.file && target === ref.target) continue;
    const path = relative(ref.kind === "source" ? projectRoot : dirname(destination), target).split(sep).join("/");
    const url = path.split("/").map(encodeURIComponent).join("/") + ref.suffix;
    const text = ref.kind === "source" ? path : ref.angled || /[()]/.test(url) ? `<${url}>` : url;
    content = content.slice(0, ref.start) + text + content.slice(ref.end);
  }
  return content;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: npm run note-refs -- <note-or-source-path>");
    process.exitCode = 1;
  } else {
    const target = resolve(input);
    const refs = collectReferences();
    const describe = (ref: NoteReference) => ({ file: relative(projectRoot, ref.file), line: ref.line,
      target: relative(projectRoot, ref.target), kind: ref.kind, exists: existsSync(ref.target) });
    console.log(JSON.stringify({ incoming: refs.filter(ref => ref.target === target).map(describe),
      outgoing: (existsSync(target) ? referencesIn(target, readFileSync(target, "utf8")) : []).map(describe) }, null, 2));
  }
}
