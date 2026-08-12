import { Check } from "typebox/value";
import {
  JsonObjectSchema,
  type ConfigurationDocumentRepository,
} from "../../modules/configuration/public.js";

export function createConfigStoreDocumentRepository(
  readDocument: () => unknown,
): ConfigurationDocumentRepository {
  return {
    async load() {
      const document = readDocument();
      if (!Check(JsonObjectSchema, document)) {
        throw new TypeError("ConfigStore returned a non-serializable document.");
      }
      return { revision: 0, document: structuredClone(document) };
    },
  };
}
