/** Archive a decision after preparing its final links, replacement metadata, and integrity seal. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { agentNoteRoot, readArchiveManifest, walkAgentNoteTree } from "./agent-note-tree.ts";
import { collectReferences, projectRoot, referencesIn, rewriteReferences } from "./note-references.ts";

function link(from: string, to: string): string {
  const url = relative(dirname(from), to).split(sep).map(encodeURIComponent).join("/");
  return /[()]/.test(url) ? "<" + url + ">" : url;
}

function metadata(content: string, lines: string[]): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  return content.replace(/^(Status: implemented)(?:\r?\n|$)/m, (_match, status: string) => status + eol + eol + lines.join(eol) + eol);
}

function writeAtomic(file: string, content: string): void {
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function main(): void {
  const { values, positionals } = parseArgs({ allowPositionals: true,
    options: { "dry-run": { type: "boolean" }, replacement: { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) {
    console.log("Usage: npm run archive-note -- <implemented-note> [--replacement <implemented-note>] [--dry-run]");
    return;
  }
  if (positionals.length !== 1) throw new Error("Specify one implemented Note. Use --help for usage.");
  const { notes, errors } = walkAgentNoteTree();
  if (errors.length) throw new Error(errors.join("\n"));
  const target = resolve(positionals[0]);
  const oldRel = relative(agentNoteRoot, target).split(sep).join("/");
  if (!notes.some(note => note.lifecycle === "implemented" && note.rel === oldRel)) {
    throw new Error("Expected an implemented Note: " + positionals[0]);
  }
  const original = readFileSync(target, "utf8");
  if (!/^Status: implemented\r?$/m.test(original) || /^Archived:/m.test(original)) throw new Error("Expected an unarchived implemented Note.");
  const archiveRel = oldRel.replace(/^implemented\//, "archived/");
  const archive = resolve(agentNoteRoot, archiveRel);
  if (existsSync(archive)) throw new Error("Archive destination already exists: " + archive);

  const replacement = values.replacement ? resolve(values.replacement) : undefined;
  if (replacement) {
    const replacementRel = relative(agentNoteRoot, replacement).split(sep).join("/");
    if (replacement === target || !notes.some(note => note.lifecycle === "implemented" && note.rel === replacementRel)
      || !/^Status: implemented\r?$/m.test(readFileSync(replacement, "utf8"))) {
      throw new Error("The replacement must be a different implemented Note.");
    }
  }

  // Validate persisted metadata before changing any files; a bad seal is never reset implicitly.
  const manifestPath = resolve(agentNoteRoot, "archived/manifest.json");
  const manifestBefore = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : undefined;
  const manifest = readArchiveManifest();
  for (const [path, expected] of Object.entries(manifest.files)) {
    const hash = "sha256:" + createHash("sha256").update(readFileSync(resolve(agentNoteRoot, path))).digest("hex");
    if (hash !== expected) throw new Error("Archive seal mismatch: " + path);
  }
  if (Object.hasOwn(manifest.files, archiveRel)) throw new Error("Archive seal already exists: " + archiveRel);

  let archived = rewriteReferences(original, referencesIn(target, original), archive,
    ref => ref.target === target ? archive : ref.target);
  archived = metadata(archived, ["Archived: " + new Date().toISOString().slice(0, 10),
    ...(replacement ? ["Superseded-by: [" + relative(projectRoot, replacement) + "](" + link(archive, replacement) + ")"] : [])]);
  const changes = new Map<string, { before: string; after: string }>();
  const incoming = collectReferences().filter(ref => ref.file !== target && ref.target === target);
  for (const file of new Set(incoming.map(ref => ref.file))) {
    const before = readFileSync(file, "utf8");
    const after = rewriteReferences(before, incoming.filter(ref => ref.file === file), file,
      ref => ref.kind === "source" && replacement ? replacement : archive);
    changes.set(file, { before, after });
  }
  if (replacement) {
    const before = changes.get(replacement)?.before ?? readFileSync(replacement, "utf8");
    const current = changes.get(replacement)?.after ?? before;
    const after = metadata(current, ["Supersedes: [" + oldRel + "](" + link(replacement, archive) + ")"]);
    changes.set(replacement, { before, after });
  }
  manifest.files[archiveRel] = "sha256:" + createHash("sha256").update(archived).digest("hex");
  manifest.files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)));
  const manifestAfter = JSON.stringify(manifest, null, 2) + "\n";

  console.log((values["dry-run"] ? "Preview" : "Archive") + ": " + oldRel + " -> " + archiveRel);
  for (const ref of incoming) console.log("Update reference: " + relative(projectRoot, ref.file) + ":" + ref.line);
  if (replacement) console.log("Replacement: " + relative(projectRoot, replacement));
  console.log("Seal: " + relative(projectRoot, manifestPath));
  if (values["dry-run"]) return;

  mkdirSync(dirname(archive), { recursive: true });
  let created = false;
  const written: string[] = [];
  let manifestWritten = false;
  try {
    // Retain the original until the archive, references, and manifest have all been written.
    const file = openSync(archive, "wx");
    created = true;
    try { writeFileSync(file, archived, "utf8"); } finally { closeSync(file); }
    for (const [file, change] of changes) {
      writeAtomic(file, change.after);
      written.push(file);
    }
    writeAtomic(manifestPath, manifestAfter);
    manifestWritten = true;
    unlinkSync(target);
  } catch (error) {
    const failures: unknown[] = [error];
    const undo = (action: () => void) => { try { action(); } catch (failure) { failures.push(failure); } };
    for (const file of written.reverse()) undo(() => writeAtomic(file, changes.get(file)!.before));
    if (manifestWritten) undo(() => manifestBefore === undefined ? unlinkSync(manifestPath) : writeAtomic(manifestPath, manifestBefore));
    if (created) undo(() => unlinkSync(archive));
    throw new AggregateError(failures, failures.length === 1 ? "Archive failed; written changes were rolled back" : "Archive failed; rollback also failed", { cause: error });
  }
  console.log("Archived. Run npm run verify-notes to check the resulting tree and seal.");
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (error instanceof AggregateError) for (const failure of error.errors) console.error(String(failure));
  process.exitCode = 1;
}
