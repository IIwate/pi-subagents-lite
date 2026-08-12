import { Check } from "typebox/value";
import {
  ConfigurationDocumentSnapshotSchema,
  ReadConfigurationValueCommandSchema,
  type ReadConfigurationValueResult,
} from "../contracts/configuration-contracts.js";
import { readJsonPath } from "../core/read-json-path.js";
import type { ConfigurationDocumentRepository } from "../ports/configuration-document-repository.js";

export interface Configuration {
  execute(command: unknown): Promise<ReadConfigurationValueResult>;
}

export interface CreateConfigurationOptions {
  repository: ConfigurationDocumentRepository;
}

function failure(
  code: "invalid-command" | "repository-failure" | "invalid-repository-result",
  message: string,
): ReadConfigurationValueResult {
  return { ok: false, error: { code, message } };
}

export function createConfiguration(options: CreateConfigurationOptions): Configuration {
  return {
    async execute(command: unknown): Promise<ReadConfigurationValueResult> {
      if (!Check(ReadConfigurationValueCommandSchema, command)) {
        return failure("invalid-command", "Configuration command is invalid.");
      }

      try {
        const snapshot = await options.repository.load();
        if (!Check(ConfigurationDocumentSnapshotSchema, snapshot)) {
          return failure("invalid-repository-result", "Configuration repository returned invalid data.");
        }
        const read = readJsonPath(snapshot.document, command.path);
        return read.found
          ? { ok: true, revision: snapshot.revision, found: true, value: read.value }
          : { ok: true, revision: snapshot.revision, found: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown repository failure.";
        return failure("repository-failure", message);
      }
    },
  };
}
