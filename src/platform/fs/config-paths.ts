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

/** Project-level configuration document under the session cwd. */
export function projectConfigFilePath(cwd: string, configDirName: string): string {
  return path.join(cwd, configDirName, "subagents-lite.json");
}

/**
 * Lexical identity key for one configuration file path: forward slashes,
 * Windows-style paths lowercased (same comparison stance as the worktree
 * validator). A relative input is resolved by the host first, so it keys to
 * its absolute twin. Deliberately no realpath — symlink/junction aliases may
 * map to different keys, which is the accepted boundary for absent files.
 */
export function normalizeConfigPathKey(filePath: string): string {
  const isWindowsStyle = (value: string) => /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
  let pathApi = isWindowsStyle(filePath) ? path.win32 : path.posix;
  let absolute = filePath;
  if (!pathApi.isAbsolute(absolute)) {
    absolute = path.resolve(absolute);
    // Host resolution can change the style verdict; re-read it so the
    // lowercasing stance matches the resolved form, not the relative input.
    pathApi = isWindowsStyle(absolute) ? path.win32 : path.posix;
  }
  const normalized = pathApi.normalize(absolute).replace(/\\/g, "/");
  return pathApi === path.win32 ? normalized.toLowerCase() : normalized;
}
