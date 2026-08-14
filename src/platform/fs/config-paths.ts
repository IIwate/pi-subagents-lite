import * as path from "node:path";

/**
 * config-paths.ts — Physical locations of the extension's persisted files.
 *
 * Callers pass the resolved home directory explicitly so path policy stays
 * testable and no module-scope process access hides inside path building.
 */

/** Root directory for all persisted extension state (`~/.pi/agent`). */
export function resolveConfigRoot(home: string): string {
  return path.join(home, ".pi", "agent");
}

/** The one persisted configuration document. */
export function configFilePath(configRoot: string): string {
  return path.join(configRoot, "subagents-lite.json");
}

/** Optional custom system prompt used by the "custom" prompt mode. */
export function customPromptFilePath(configRoot: string): string {
  return path.join(configRoot, "subagents-lite-prompt.md");
}

/** User-level Agent definition directory scanned at session start. */
export function userAgentsDirPath(configRoot: string): string {
  return path.join(configRoot, "agents");
}

/** Project-level Agent definition directory under the session cwd. */
export function projectAgentsDirPath(cwd: string): string {
  return path.join(cwd, ".pi", "agents");
}
