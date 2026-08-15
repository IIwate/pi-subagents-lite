/**
 * host-resources.ts — Canonical Pi installation paths as a validated snapshot.
 *
 * Pi's `getAgentDir()` and `CONFIG_DIR_NAME` are the only sources for the
 * extension's global resource root and the project config directory name.
 * The adapter freezes both into one serializable snapshot at module load and
 * fails closed: if either fact is unusable the extension must not activate
 * with configuration it cannot locate.
 *
 * Pi's agent-directory environment override is handled entirely inside
 * `getAgentDir()`; the variable name is not part of this repository's
 * contract (it changes with Pi's APP_NAME rebrand), so tests inject readers
 * through `createHostInstallationPaths` instead of setting that variable.
 */

import * as path from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const HostInstallationPathsSchema = Type.Object({
  /** Pi getAgentDir() resolved to an absolute path. */
  agentDirectory: Type.String({ minLength: 1 }),
  /** Pi CONFIG_DIR_NAME validated as a single directory segment, e.g. ".pi". */
  projectConfigDirectoryName: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export type HostInstallationPaths = Static<typeof HostInstallationPathsSchema>;

/** Injectable readers over the two Pi installation facts. */
export interface HostResourceReaders {
  getAgentDir(): string;
  configDirName: string;
}

/**
 * Build the validated snapshot. Throws TypeError on any invariant violation:
 * a relative agent directory or a multi-segment/traversal config dir name
 * would silently relocate every persisted file, so refusing activation is
 * safer than guessing.
 */
export function createHostInstallationPaths(readers: HostResourceReaders): HostInstallationPaths {
  const rawAgentDir = readers.getAgentDir();
  if (typeof rawAgentDir !== "string" || rawAgentDir.length === 0 || !path.isAbsolute(rawAgentDir)) {
    throw new TypeError(`Pi agent directory must be a non-empty absolute path, got ${JSON.stringify(rawAgentDir)}.`);
  }
  const name = readers.configDirName;
  const isSingleSegment = typeof name === "string"
    && name.length > 0
    && name !== "."
    && name !== ".."
    && !name.includes("/")
    && !name.includes("\\")
    && !path.isAbsolute(name);
  if (!isSingleSegment) {
    throw new TypeError(`Pi project config directory name must be a single path segment, got ${JSON.stringify(name)}.`);
  }
  const snapshot: HostInstallationPaths = {
    agentDirectory: path.resolve(rawAgentDir),
    projectConfigDirectoryName: name,
  };
  if (!Check(HostInstallationPathsSchema, snapshot)) {
    throw new TypeError("Pi installation path snapshot violates its schema.");
  }
  return snapshot;
}

/**
 * The one process-wide snapshot, taken at module evaluation so it is stable
 * before bootstrap/configuration derives its module constants from it.
 */
export const hostInstallationPaths: HostInstallationPaths = createHostInstallationPaths({
  getAgentDir,
  configDirName: CONFIG_DIR_NAME,
});
