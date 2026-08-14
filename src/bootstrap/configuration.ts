import { homedir } from "node:os";
import * as path from "node:path";
import {
  createConfiguration,
  resolveOperationalValue,
  type Configuration,
  type ConfigurationResult,
  type JsonValue,
} from "../modules/configuration/public.js";
import { createProcessEnvironmentSource } from "../platform/process/environment-source.js";
import { createFileConfigurationDocumentRepository } from "../platform/fs/configuration-document-repository.js";
import {
  configFilePath,
  customPromptFilePath,
  resolveConfigRoot,
} from "../platform/fs/config-paths.js";

const environment = createProcessEnvironmentSource({
  env: process.env,
  dotEnvFilePath: path.join(process.cwd(), ".env"),
});

// HOME is the only operational setting today. The config-file step of the
// precedence chain cannot apply to it: the document's own location derives
// from this value, so it cannot locate itself. Interactive product policies
// never pass through this resolution.
//
// The OS home directory is the capability default rather than an empty string.
// Windows usually leaves HOME unset and exposes the profile through
// USERPROFILE, so an empty fallback resolved the document to a cwd-relative
// `.pi/agent` — a different config file per working directory, and a different
// root than skill discovery used.
export const configHome = resolveOperationalValue({
  environment: environment.variable("HOME"),
  dotEnv: environment.dotEnvValue("HOME"),
  fallback: homedir(),
});

export const configRoot = resolveConfigRoot(configHome);
export const customPromptPath = customPromptFilePath(configRoot);

/**
 * The one configuration runtime for the extension process. Deliberately
 * process-scoped rather than per-ExtensionRuntime: the document is one file
 * on disk, and two runtimes observing different revisions of it would turn
 * every cross-runtime commit into a spurious revision conflict.
 */
export const configuration: Configuration = createConfiguration({
  repository: createFileConfigurationDocumentRepository({
    filePath: configFilePath(configRoot),
  }),
});

/** Top-level document sections with a live owner. */
type ConfigSection = "modelRouting" | "agent" | "concurrency";

type ConfigSectionFailureCode = Extract<ConfigurationResult, { ok: false }>["error"]["code"];

/** Outcome of a section commit. Failure includes the module error code. */
export type ConfigSectionCommitResult =
  | { ok: true }
  | { ok: false; code: ConfigSectionFailureCode; message: string };

/** Section-level document access, backed by the configuration module. */
export interface ConfigSectionIO {
  reload(): void;
  read(section: ConfigSection): unknown;
  commit(section: ConfigSection, assignments: Record<string, JsonValue>): ConfigSectionCommitResult;
}

/**
 * Adapter over the configuration facade. Owners share one instance (below) so
 * every read refreshes the same observed revision; an owner that reads its
 * fragment at the start of each update can therefore never commit against a
 * revision another owner already advanced.
 */
export function createConfigurationSectionIO(source: Configuration): ConfigSectionIO {
  let revision = 0;
  return {
    reload() {
      const result = source.execute({ kind: "reload" });
      if (result.ok) revision = result.revision;
    },
    read(section) {
      const result = source.execute({ kind: "read-value", path: [section] });
      if (!result.ok) return undefined;
      revision = result.revision;
      return "found" in result && result.found ? result.value : undefined;
    },
    commit(section, assignments) {
      const result = source.execute({
        kind: "commit-fragment",
        expectedRevision: revision,
        section,
        assignments,
      });
      // Callers distinguish persistence-failure from revision-conflict; a
      // message alone collapses those into a toast they cannot branch on.
      if (!result.ok) return { ok: false, code: result.error.code, message: result.error.message };
      revision = result.revision;
      return { ok: true };
    },
  };
}

/** The shared section IO every fragment owner writes through. */
export const configurationSectionIO: ConfigSectionIO = createConfigurationSectionIO(configuration);
