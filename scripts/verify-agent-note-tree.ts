/**
 * Verify tree: lifecycle/class/filename/INDEX and internal relative markdown links.
 * Run: npx tsx scripts/verify-agent-note-tree.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { agentNoteRoot, walkAgentNoteTree } from "./agent-note-tree.ts";
import { referencesIn } from "./note-references.ts";

const { notes, errors } = walkAgentNoteTree();

// Check relative markdown links inside active notes
for (const note of notes) {
  const noteFullPath = resolve(agentNoteRoot, note.rel);
  const content = readFileSync(noteFullPath, "utf8");
  for (const ref of referencesIn(noteFullPath, content)) {
    // Only verify internal links within agentNoteRoot
    const target = relative(agentNoteRoot, ref.target);
    if (target === ".." || target.startsWith(".." + sep) || isAbsolute(target)) continue;
    if (!existsSync(ref.target)) {
      errors.push(`link: ${note.rel}:${ref.line} -> "${target}" target file does not exist`);
    }
  }
}

if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}

console.log(`ok: ${notes.length} note(s) tree and relative links verified`);
