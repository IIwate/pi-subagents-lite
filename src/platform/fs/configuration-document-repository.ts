import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ConfigurationDocumentRepository,
  JsonObject,
} from "../../modules/configuration/public.js";

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface CreateFileConfigurationDocumentRepositoryOptions {
  filePath: string;
}

/**
 * JSON-file implementation of the configuration document port.
 *
 * load never throws: a missing, malformed, or non-object file (including the
 * JSON literal `null`) resolves to an empty document so startup cannot break.
 * persist writes tmp-then-rename for atomicity and deliberately propagates
 * failures — swallowing them here is exactly the bug REQ-CONFIG-001 corrects.
 */
export function createFileConfigurationDocumentRepository(
  options: CreateFileConfigurationDocumentRepositoryOptions,
): ConfigurationDocumentRepository {
  return {
    load(): JsonObject {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(options.filePath, "utf-8"));
      } catch {
        return {};
      }
      return isPlainObject(parsed) ? parsed : {};
    },
    persist(document: JsonObject): void {
      const tmpPath = options.filePath + ".tmp";
      fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(document, null, 2), "utf-8");
      fs.renameSync(tmpPath, options.filePath);
    },
  };
}
