/**
 * Verify tree: lifecycle/class/filename/INDEX and repository-relative markdown links.
 * Run: npx tsx scripts/verify-agent-note-tree.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { agentNoteRoot, walkAgentNoteTree } from "./agent-note-tree.ts";

// Note: see .agents/notes/implemented/testing/2026-09-09-test-layers-and-scenario-harness.md
const { notes, errors } = walkAgentNoteTree();
const repoRoot = resolve(agentNoteRoot, "../..");

// Check relative markdown links inside active notes
const LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;

for (const note of notes) {
  const noteFullPath = resolve(agentNoteRoot, note.rel);
  const content = readFileSync(noteFullPath, "utf8");
  let match: RegExpExecArray | null;

  while ((match = LINK_REGEX.exec(content)) !== null) {
    const rawTarget = match[2]?.trim();
    if (!rawTarget) continue;

    // Ignore web links, intra-page anchors and ellipsis placeholders
    if (rawTarget.startsWith("http://") || rawTarget.startsWith("https://") || rawTarget.startsWith("#") || rawTarget.startsWith("mailto:") || rawTarget.includes("…")) {
      continue;
    }

    // Strip anchor fragment if present
    const fileTarget = rawTarget.split("#")[0];
    if (!fileTarget) continue;

    const resolvedTarget = resolve(dirname(noteFullPath), fileTarget);

    // Notes link to test and source files as well as other decisions.
    if (resolvedTarget !== repoRoot && !resolvedTarget.startsWith(repoRoot + sep)) {
      continue;
    }

    if (!existsSync(resolvedTarget)) {
      errors.push(`link: ${note.rel} -> "${rawTarget}" target file does not exist`);
    }
  }
}

if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}

console.log(`ok: ${notes.length} note(s) tree and relative links verified`);
