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
  worktreeDefinitions: readonly AgentSourceDefinition[] = [],
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
  // Worktree files keep project attribution, but they only fill a vacant
  // name. Folding them into the project pass would let a later checkout
  // rewrite a definition the parent already settled, and the registry
  // would never see that it had happened. Revisit only if worktree types
  // are allowed to shadow parent names.
  for (const source of worktreeDefinitions) {
    if (definitions.has(source.name)) continue;
    definitions.set(source.name, {
      description: "",
      ...structuredClone(source),
      source: source.source,
    });
  }
  return [...definitions.values()];
}
