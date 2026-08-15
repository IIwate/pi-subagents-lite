import { Check } from "typebox/value";
import {
  ConfigurationCommandSchema,
  ConfigurationDocumentLoadResultSchema,
  ConfigurationResultSchema,
  type ConfigurationDocumentStatus,
  type ConfigurationResult,
  type JsonObject,
} from "../contracts/configuration-contracts.js";
import { applyFragmentAssignments } from "../core/apply-fragment.js";
import { readJsonPath } from "../core/read-json-path.js";
import type { ConfigurationDocumentRepository } from "../ports/configuration-document-repository.js";

export type { ConfigurationResult };

export interface Configuration {
  execute(command: unknown): ConfigurationResult;
}

/**
 * Per-document commit behavior when the persisted file is malformed.
 * `reset-on-commit` treats it as an empty document and overwrites (global
 * status quo); `read-only` refuses with `document-malformed` and never
 * touches disk (project layer).
 */
export type MalformedDocumentPolicy = "reset-on-commit" | "read-only";

export interface CreateConfigurationOptions {
  repository: ConfigurationDocumentRepository;
  malformedPolicy?: MalformedDocumentPolicy;
}

type FailureCode =
  | "invalid-command"
  | "repository-failure"
  | "invalid-repository-result"
  | "revision-conflict"
  | "persistence-failure"
  | "document-malformed";

function failure(code: FailureCode, message: string): { ok: false; error: { code: FailureCode; message: string } } {
  return { ok: false, error: { code, message } };
}

/**
 * The last door a configuration result walks through. A path read can hand
 * back a value that was JSON when it was written and is not JSON now — a
 * function parked on the document, a revision that stopped being an
 * integer. Callers treat `ok` as a complete picture they can commit against,
 * so a half-valid success is how one bad field becomes the next expected
 * revision. invalid-command is the only failure this schema names for a
 * broken view; persistence codes stay reserved for the port.
 */
function outbound(result: ConfigurationResult): ConfigurationResult {
  return Check(ConfigurationResultSchema, result)
    ? result
    : failure("invalid-command", "Configuration result does not match its contract.");
}

/**
 * The configuration facade owns the one in-memory document. Reads never touch
 * the repository, so a consumer cannot observe a half-written file; writes
 * publish only after the repository persisted the candidate (REQ-CONFIG-001).
 * The revision is transaction metadata and is never written to disk.
 */
export function createConfiguration(options: CreateConfigurationOptions): Configuration {
  const malformedPolicy = options.malformedPolicy ?? "reset-on-commit";
  let revision = 0;
  let document: JsonObject = {};
  let status: ConfigurationDocumentStatus = "absent";
  let malformedMessage = "";

  function loadFromRepository(): ConfigurationResult {
    let loaded: unknown;
    try {
      loaded = options.repository.load();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown repository failure.";
      return failure("repository-failure", message);
    }
    if (!Check(ConfigurationDocumentLoadResultSchema, loaded)) {
      return failure("invalid-repository-result", "Configuration repository returned an invalid load result.");
    }
    // absent and malformed both read as an empty document (current startup
    // behavior); the status is what lets a read-only policy refuse writes.
    status = loaded.status;
    malformedMessage = loaded.status === "malformed" ? loaded.message : "";
    document = loaded.status === "loaded" ? loaded.document : {};
    revision += 1;
    return { ok: true, revision, status };
  }

  const initial = loadFromRepository();
  if (!initial.ok) {
    // Startup keeps the approved current behavior: an unreadable document
    // resolves to capability defaults rather than blocking the session. The
    // status is malformed so a read-only policy still refuses writes.
    document = {};
    status = "malformed";
    malformedMessage = initial.error.message;
  }

  return {
    execute(command: unknown): ConfigurationResult {
      return outbound(run(command));
    },
  };

  function run(command: unknown): ConfigurationResult {
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
        const removals = command.removals ?? [];
        if (removals.some((key) => Object.hasOwn(command.assignments, key))) {
          return failure("invalid-command", "Commit assignments and removals overlap.");
        }
        if (malformedPolicy === "read-only" && status === "malformed") {
          // The file could not be read, so a write would destroy whatever the
          // user meant it to say. Refuse; the user fixes the file, not us.
          return failure(
            "document-malformed",
            `Configuration document is malformed and this document is read-only until fixed: ${malformedMessage}`,
          );
        }
        const candidate = applyFragmentAssignments(document, command.section, command.assignments, removals);
        try {
          options.repository.persist(candidate);
        } catch (error) {
          // The old fragment stays effective for every consumer; the caller
          // must surface this failure instead of assuming the update landed.
          const message = error instanceof Error ? error.message : "Unknown persistence failure.";
          return failure("persistence-failure", message);
        }
        document = candidate;
        status = "loaded";
        revision += 1;
        return { ok: true, revision };
      }
      case "reload":
        return loadFromRepository();
    }
  }
}
