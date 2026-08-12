import { DEFAULT_AGENTS } from "../agents/default-agents.js";
import {
  createAgentCatalogue,
  type AgentCatalogue,
  type AgentDefinitionSnapshot,
} from "../modules/agent-catalogue/public.js";
import { createFileAgentCatalogueRepository } from "../platform/fs/agent-catalogue-repository.js";

function builtInDefinitions(): AgentDefinitionSnapshot[] {
  return [...DEFAULT_AGENTS.values()].map((definition) => ({
    ...structuredClone(definition),
    source: "built-in",
  }));
}

export function createAgentCatalogueRuntime(): AgentCatalogue {
  return createAgentCatalogue({
    repository: createFileAgentCatalogueRepository(),
    builtInDefinitions: builtInDefinitions(),
  });
}
