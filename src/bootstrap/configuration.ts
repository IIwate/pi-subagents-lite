import * as path from "node:path";
import {
  createConfiguration,
  resolveOperationalValue,
  type Configuration,
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
const home = resolveOperationalValue({
  environment: environment.variable("HOME"),
  dotEnv: environment.dotEnvValue("HOME"),
  fallback: "",
});

export const configRoot = resolveConfigRoot(home);
export const customPromptPath = customPromptFilePath(configRoot);

/**
 * The one configuration runtime for the extension process. Module scope keeps
 * it constructible before the session shell exists; Phase 8 moves ownership
 * into the explicit composition root.
 */
export const configuration: Configuration = createConfiguration({
  repository: createFileConfigurationDocumentRepository({
    filePath: configFilePath(configRoot),
  }),
});
