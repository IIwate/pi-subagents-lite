import type { AgentGuidanceRequest, AgentGuidanceResult } from "../contracts/prompt-contracts.js";
import type { PromptCatalogueReader } from "../ports/catalogue-reader.js";
import { assembleAgentGuidance } from "./assemble-agent-guidance.js";

export interface ParentGuidanceHostSnapshot {
  parentModelKey: string;
  parentThinkingLevel: AgentGuidanceRequest["parentThinkingLevel"];
  parentSupportedLevels: AgentGuidanceRequest["parentSupportedLevels"];
  parentFallbackLevel: AgentGuidanceRequest["parentFallbackLevel"];
  parentScopedThinkingLevel: AgentGuidanceRequest["parentScopedThinkingLevel"];
  routing: AgentGuidanceRequest["routing"];
  availableModels: AgentGuidanceRequest["availableModels"];
  scopedKeys: AgentGuidanceRequest["scopedKeys"];
}

export function createParentGuidance(options: { catalogue: PromptCatalogueReader }) {
  return {
    assemble(host: ParentGuidanceHostSnapshot): AgentGuidanceResult {
      return assembleAgentGuidance({
        kind: "assemble-guidance",
        agents: options.catalogue.listAgents().map((agent) => ({ ...agent })),
        ...host,
      });
    },
  };
}
