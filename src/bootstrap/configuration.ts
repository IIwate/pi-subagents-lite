import {
  createConfiguration,
  type Configuration,
} from "../modules/configuration/public.js";
import { createFileConfigurationDocumentRepository } from "../platform/fs/configuration-document-repository.js";
import { configFilePath, resolveConfigRoot } from "../platform/fs/config-paths.js";

/**
 * The one configuration runtime for the extension process. Module scope keeps
 * it constructible before the session shell exists; Phase 8 moves ownership
 * into the explicit composition root.
 */
export const configuration: Configuration = createConfiguration({
  repository: createFileConfigurationDocumentRepository({
    filePath: configFilePath(resolveConfigRoot(process.env)),
  }),
});
