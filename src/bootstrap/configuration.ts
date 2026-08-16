import { homedir } from "node:os";
import * as path from "node:path";
import { Check } from "typebox/value";
import {
  createConfiguration,
  resolveOperationalValue,
  ConfigurationCommitFailureCodeSchema,
  type Configuration,
  type ConfigurationCommitFailureCode,
  type ConfigurationDocumentStatus,
  type JsonValue,
} from "../modules/configuration/public.js";
import { createProcessEnvironmentSource } from "../platform/process/environment-source.js";
import { createFileConfigurationDocumentRepository } from "../platform/fs/configuration-document-repository.js";
import {
  configFilePath,
  customPromptFilePath,
  normalizeConfigPathKey,
  projectConfigFilePath,
} from "../platform/fs/config-paths.js";
import { hostInstallationPaths } from "../platform/pi/host-resources.js";

const environment = createProcessEnvironmentSource({
  env: process.env,
  dotEnvFilePath: path.join(process.cwd(), ".env"),
});

// HOME is the only operational setting today and it now serves exactly one
// consumer: the `<home>/.agents/skills` skill root. Every persisted extension
// file (config document, custom prompt, global Agent definitions) derives
// from Pi's agent directory instead, so a custom HOME can no longer split
// the extension's config root from the child session's Pi root.
//
// The OS home directory is the capability default rather than an empty
// string: Windows usually leaves HOME unset, and an empty fallback would
// resolve the skill root to a cwd-relative path.
export const skillsUserHome = resolveOperationalValue({
  environment: environment.variable("HOME"),
  dotEnv: environment.dotEnvValue("HOME"),
  fallback: homedir(),
});

export const customPromptPath = customPromptFilePath(hostInstallationPaths.agentDirectory);

/**
 * The one configuration runtime for the extension process. Deliberately
 * process-scoped rather than per-ExtensionRuntime: the document is one file
 * on disk, and two runtimes observing different revisions of it would turn
 * every cross-runtime commit into a spurious revision conflict.
 */
export const configuration: Configuration = createConfiguration({
  repository: createFileConfigurationDocumentRepository({
    filePath: configFilePath(hostInstallationPaths.agentDirectory),
  }),
});

/** Top-level document sections with a live owner. */
type ConfigSection = "modelRouting" | "agent" | "concurrency";

/** Outcome of a section commit. Failure carries only the save-refusal codes. */
export type ConfigSectionCommitResult =
  | { ok: true }
  | { ok: false; code: ConfigurationCommitFailureCode; message: string };

/** Section-level document access, backed by the configuration module. */
export interface ConfigSectionIO {
  reload(): ConfigurationDocumentStatus | undefined;
  read(section: ConfigSection): unknown;
  commit(
    section: ConfigSection,
    assignments: Record<string, JsonValue>,
    removals?: readonly string[],
  ): ConfigSectionCommitResult;
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
      if (!result.ok) return undefined;
      revision = result.revision;
      return "status" in result ? result.status : undefined;
    },
    read(section) {
      const result = source.execute({ kind: "read-value", path: [section] });
      if (!result.ok) return undefined;
      revision = result.revision;
      return "found" in result && result.found ? result.value : undefined;
    },
    commit(section, assignments, removals) {
      const result = source.execute({
        kind: "commit-fragment",
        expectedRevision: revision,
        section,
        assignments,
        ...(removals && removals.length > 0 ? { removals: [...removals] } : {}),
      });
      // Callers distinguish persistence-failure from revision-conflict; a
      // message alone collapses those into a toast they cannot branch on.
      // Commit-fragment names only those two save refusals. A different
      // code is a facade that broke its own door, not a third reason to
      // leave the page — mapping it onto persistence-failure would invent
      // a disk failure that never happened.
      if (!result.ok) {
        const { code, message } = result.error;
        if (!Check(ConfigurationCommitFailureCodeSchema, code)) {
          throw new TypeError(`Configuration commit returned unusable failure code ${code}.`);
        }
        return { ok: false, code, message };
      }
      revision = result.revision;
      return { ok: true };
    },
  };
}

/** The shared section IO every fragment owner writes through. */
export const configurationSectionIO: ConfigSectionIO = createConfigurationSectionIO(configuration);

/* ------------------------------------------------------------------ */
/*  Project configuration binding (REQ-CONFIG-003)                    */
/* ------------------------------------------------------------------ */

/** Settings-page vocabulary for the project layer; computed here, owned by settings. */
export type ProjectLayerDocumentState = "untrusted" | ConfigurationDocumentStatus;

/**
 * Per-session handle onto the project configuration document. Untrusted
 * sessions get a bare handle with no file path and no IO, so the document is
 * never read; getState() is a live read, not a captured snapshot.
 */
export interface ProjectConfigurationBinding {
  getState(): ProjectLayerDocumentState;
  filePath?: string;
  sectionIO?: ConfigSectionIO;
}

/**
 * One facade per lexically normalized project config path, process-scoped for
 * the same reason as the global `configuration` constant: two runtimes
 * observing independent revisions of one file would turn every cross-runtime
 * commit into a spurious conflict. Symlink/junction aliases may produce
 * different keys; that is the accepted boundary (no realpath for possibly
 * absent files).
 *
 * `state` lives on the owner entry, not on a binding: every binding reads the
 * committed document through the shared facade, so a per-binding state copy
 * would lag behind commits made through a sibling binding (absent shown while
 * the shared document is already loaded).
 */
interface ProjectDocumentOwner {
  configuration: Configuration;
  sectionIO: ConfigSectionIO;
  state: ConfigurationDocumentStatus;
}

const projectDocumentOwners = new Map<string, ProjectDocumentOwner>();

export function bindProjectConfiguration(trusted: boolean, cwd: string): ProjectConfigurationBinding {
  if (!trusted) {
    return { getState: () => "untrusted" };
  }
  const filePath = projectConfigFilePath(cwd, hostInstallationPaths.projectConfigDirectoryName);
  const key = normalizeConfigPathKey(filePath);
  let owner = projectDocumentOwners.get(key);
  if (!owner) {
    const projectConfiguration = createConfiguration({
      repository: createFileConfigurationDocumentRepository({ filePath }),
      // A malformed project file is excluded from the effective layer and
      // must never be overwritten or auto-repaired.
      malformedPolicy: "read-only",
    });
    owner = {
      configuration: projectConfiguration,
      sectionIO: createConfigurationSectionIO(projectConfiguration),
      // Placeholder until the reload below observes the disk state.
      state: "absent",
    };
    projectDocumentOwners.set(key, owner);
  }
  const entry = owner;
  // Session-start reload observes the current disk state; the state then
  // changes only when a reload or a commit through any binding of this path
  // succeeds (absent→loaded). Mid-session external edits become visible at
  // the next reload, matching the global document's behavior.
  //
  // Trust boundary: this wrapper mirrors, not enforces, the facade's
  // malformed handling — the write refusal itself is owned by the facade's
  // read-only malformedPolicy. The two can only diverge if a repository
  // violates its load port behavior (throws or returns a non-contract
  // shape); the file repository composed above catches every load failure,
  // so a "malformed" shown here while the facade still commits is not
  // reachable in this composition and gets no second guard.
  entry.state = entry.sectionIO.reload() ?? "malformed";
  const sectionIO: ConfigSectionIO = {
    reload() {
      const status = entry.sectionIO.reload();
      entry.state = status ?? "malformed";
      return status;
    },
    read(section) {
      return entry.sectionIO.read(section);
    },
    commit(section, assignments, removals) {
      const result = entry.sectionIO.commit(section, assignments, removals);
      if (result.ok) entry.state = "loaded";
      return result;
    },
  };
  return {
    getState: () => entry.state,
    filePath,
    sectionIO,
  };
}
