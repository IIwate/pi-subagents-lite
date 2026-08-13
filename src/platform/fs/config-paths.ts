import * as path from "node:path";

/**
 * config-paths.ts — Physical locations of the extension's persisted files.
 *
 * Callers pass the host environment explicitly so path policy stays testable
 * and no module-scope process access hides inside path building.
 */

/** Root directory for all persisted extension state (`~/.pi/agent`). */
export function resolveConfigRoot(env: Readonly<Record<string, string | undefined>>): string {
  return path.join(env.HOME || "", ".pi", "agent");
}

/** The one persisted configuration document. */
export function configFilePath(configRoot: string): string {
  return path.join(configRoot, "subagents-lite.json");
}

/** Optional custom system prompt used by the "custom" prompt mode. */
export function customPromptFilePath(configRoot: string): string {
  return path.join(configRoot, "subagents-lite-prompt.md");
}
