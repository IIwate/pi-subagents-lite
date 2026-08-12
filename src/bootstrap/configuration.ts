import {
  createConfiguration,
  type Configuration,
} from "../modules/configuration/public.js";
import { createConfigStoreDocumentRepository } from "../platform/configuration/config-store-document-repository.js";
import { getStore } from "../shell.js";

export function createConfigurationRuntime(): Configuration {
  return createConfiguration({
    repository: createConfigStoreDocumentRepository(() => {
      const store = getStore();
      return {
        modelRouting: store.routing,
        agent: store.agent,
        concurrency: store.concurrency,
      };
    }),
  });
}
