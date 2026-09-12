import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

/** Resolve the task's execution directory before preparing cwd-bound resources. */
// Note: see .agents/notes/implemented/architecture/2026-09-12-task-working-directory.md
export async function resolveWorkingDirectory(cwd: unknown, parentCwd: string): Promise<string> {
  if (cwd !== undefined && (typeof cwd !== "string" || !cwd.trim())) {
    throw new Error("cwd must be a non-empty directory path");
  }
  const target = resolve(parentCwd, cwd ?? ".");
  try {
    const directory = await realpath(target);
    if (!(await stat(directory)).isDirectory()) throw new Error("not a directory");
    return directory;
  } catch (error) {
    throw new Error(`Cannot use cwd ${JSON.stringify(target)}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
