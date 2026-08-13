import { Check } from "typebox/value";
import {
  ConfigurationCommandSchema,
  JsonObjectSchema,
  type CommitConfigurationFragmentResult,
  type JsonObject,
  type ReadConfigurationValueResult,
  type ReloadConfigurationResult,
} from "../contracts/configuration-contracts.js";
import { applyFragmentAssignments } from "../core/apply-fragment.js";
import { readJsonPath } from "../core/read-json-path.js";
import type { ConfigurationDocumentRepository } from "../ports/configuration-document-repository.js";

export type ConfigurationResult =
  | ReadConfigurationValueResult
  | CommitConfigurationFragmentResult
  | ReloadConfigurationResult;

export interface Configuration {
  execute(command: unknown): ConfigurationResult;
}

export interface CreateConfigurationOptions {
  repository: ConfigurationDocumentRepository;
}

type FailureCode =
  | "invalid-command"
  | "repository-failure"
  | "invalid-repository-result"
  | "revision-conflict"
  | "persistence-failure";

function failure(code: FailureCode, message: string): { ok: false; error: { code: FailureCode; message: string } } {
  return { ok: false, error: { code, message } };
}

/**
 * The configuration facade owns the one in-memory document. Reads never touch
 * the repository, so a consumer cannot observe a half-written file; writes
 * publish only after the repository persisted the candidate (REQ-CONFIG-001).
 * The revision is transaction metadata and is never written to disk.
 */
export function createConfiguration(options: CreateConfigurationOptions): Configuration {
  let revision = 0;
  let document: JsonObject = {};

  function loadFromRepository(): ConfigurationResult {
    let loaded: JsonObject;
    try {
      loaded = options.repository.load();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown repository failure.";
      return failure("repository-failure", message);
    }
    if (!Check(JsonObjectSchema, loaded)) {
      return failure("invalid-repository-result", "Configuration repository returned a non-JSON document.");
    }
    document = loaded;
    revision += 1;
    return { ok: true, revision };
  }

  const initial = loadFromRepository();
  if (!initial.ok) {
    // Startup keeps the approved current behavior: an unreadable document
    // resolves to capability defaults rather than blocking the session.
    document = {};
  }

  return {
    execute(command: unknown): ConfigurationResult {
      if (!Check(ConfigurationCommandSchema, command)) {
        return failure("invalid-command", "Configuration command is invalid.");
      }

      switch (command.kind) {
        case "read-value": {
          const read = readJsonPath(document, command.path);
          return read.found
            ? { ok: true, revision, found: true, value: read.value }
            : { ok: true, revision, found: false };
        }
        case "commit-fragment": {
          if (command.expectedRevision !== revision) {
            return failure(
              "revision-conflict",
              `Expected revision ${command.expectedRevision} but the current document is at ${revision}.`,
            );
          }
          const candidate = applyFragmentAssignments(document, command.section, command.assignments);
          try {
            options.repository.persist(candidate);
          } catch (error) {
            // The old fragment stays effective for every consumer; the caller
            // must surface this failure instead of assuming the update landed.
            const message = error instanceof Error ? error.message : "Unknown persistence failure.";
            return failure("persistence-failure", message);
          }
          document = candidate;
          revision += 1;
          return { ok: true, revision };
        }
        case "reload":
          return loadFromRepository();
      }
    },
  };
}
