import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ConfigurationDocumentLoadResult,
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
 * load never throws and reports three states: a missing file (ENOENT) is
 * `absent`; bad JSON, non-object content (including the JSON literal
 * `null`), and any other read failure are `malformed` with a message —
 * an unknown read error must not masquerade as an absent file, or a
 * read-only policy would let a commit overwrite data it never saw.
 * persist writes tmp-then-rename for atomicity and deliberately propagates
 * failures — swallowing them here is exactly the bug REQ-CONFIG-001 corrects.
 */
export function createFileConfigurationDocumentRepository(
  options: CreateFileConfigurationDocumentRepositoryOptions,
): ConfigurationDocumentRepository {
  return {
    load(): ConfigurationDocumentLoadResult {
      let text: string;
      try {
        text = fs.readFileSync(options.filePath, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
        const message = error instanceof Error ? error.message : "Unknown read failure.";
        return { status: "malformed", message };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid JSON.";
        return { status: "malformed", message };
      }
      return isPlainObject(parsed)
        ? { status: "loaded", document: parsed }
        : { status: "malformed", message: "Configuration document is not a JSON object." };
    },
    persist(document: JsonObject): void {
      const tmpPath = options.filePath + ".tmp";
      fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(document, null, 2), "utf-8");
      fs.renameSync(tmpPath, options.filePath);
    },
  };
}
