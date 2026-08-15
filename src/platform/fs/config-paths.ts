import * as path from "node:path";

/**
 * config-paths.ts — Physical locations of the extension's persisted files.
 *
 * Callers pass the resolved roots explicitly — the Pi agent directory for
 * global files and Pi's project config directory name for project files — so
 * path policy stays testable and no hardcoded location hides inside path
 * building. The canonical sources of both roots live in
 * `platform/pi/host-resources.ts`.
 */

/** The one persisted global configuration document. */
export function configFilePath(agentDirectory: string): string {
  return path.join(agentDirectory, "subagents-lite.json");
}

/** Optional custom system prompt used by the "custom" prompt mode. */
export function customPromptFilePath(agentDirectory: string): string {
  return path.join(agentDirectory, "subagents-lite-prompt.md");
}

/** User-level Agent definition directory scanned at session start. */
export function userAgentsDirPath(agentDirectory: string): string {
  return path.join(agentDirectory, "agents");
}

/** Project-level Agent definition directory under the session cwd. */
export function projectAgentsDirPath(cwd: string, configDirName: string): string {
  return path.join(cwd, configDirName, "agents");
}
