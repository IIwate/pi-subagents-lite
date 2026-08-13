export interface PromptCatalogueAgent {
  name: string;
  description: string;
  registeredTools?: string[];
  maxTurns?: number;
}

export interface PromptCatalogueReader {
  listAgents(): readonly PromptCatalogueAgent[];
}
