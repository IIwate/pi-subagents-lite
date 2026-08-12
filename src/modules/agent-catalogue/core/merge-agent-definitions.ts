import type {
  AgentCatalogueConfiguration,
  AgentDefinitionSnapshot,
  AgentSourceDefinition,
} from "../contracts/catalogue-contracts.js";

function copyDefinition(definition: AgentDefinitionSnapshot): AgentDefinitionSnapshot {
  return structuredClone(definition);
}

function applySourceDefinitions(
  definitions: Map<string, AgentDefinitionSnapshot>,
  sources: readonly AgentSourceDefinition[],
): void {
  for (const source of sources) {
    const existing = definitions.get(source.name);
    definitions.set(source.name, {
      description: "",
      ...existing,
      ...structuredClone(source),
      source: source.source,
    });
  }
}

export function mergeAgentDefinitions(
  builtInDefinitions: readonly AgentDefinitionSnapshot[],
  sourceDefinitions: readonly AgentSourceDefinition[],
  configuration: AgentCatalogueConfiguration,
): AgentDefinitionSnapshot[] {
  const definitions = new Map<string, AgentDefinitionSnapshot>();
  if (!configuration.disableDefaultAgents) {
    for (const definition of builtInDefinitions) {
      definitions.set(definition.name, copyDefinition(definition));
    }
  }

  applySourceDefinitions(
    definitions,
    sourceDefinitions.filter((definition) => definition.source === "global"),
  );
  applySourceDefinitions(
    definitions,
    sourceDefinitions.filter((definition) => definition.source === "project"),
  );
  return [...definitions.values()];
}
