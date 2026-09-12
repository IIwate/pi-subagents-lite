/** Check only registered archive seals; historical links and APIs are not current contracts. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { agentNoteRoot, readArchiveManifest } from "./agent-note-tree.ts";

try {
  const manifest = readArchiveManifest();
  const errors: string[] = [];
  for (const [path, expected] of Object.entries(manifest.files)) {
    try {
      const actual = `sha256:${createHash("sha256").update(readFileSync(resolve(agentNoteRoot, path))).digest("hex")}`;
      if (actual !== expected) errors.push(`Archive seal mismatch: ${path}`);
    } catch (error) { errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`ok: verified ${Object.keys(manifest.files).length} archive seal(s).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
