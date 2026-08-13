import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRoutingConfig } from "../config/types.js";
import { assembleAgentGuidance, type AgentGuidanceRequest } from "../modules/prompt/public.js";
import type { ThinkingLevel } from "../modules/model-access/public.js";
import { modelKey, scopedModelKeys, scopedThinkingLevel } from "../models/model-scope.js";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";

export interface GuidanceAgent {
  name: string;
  description: string;
  registeredTools?: string[];
  maxTurns?: number;
}

export interface AgentGuidanceOptions {
  agents: readonly GuidanceAgent[];
  parentModel: Model<any> | undefined;
  parentThinkingLevel: ThinkingLevel | undefined;
  routing: Readonly<ModelRoutingConfig>;
  availableModels: readonly Model<any>[];
  scopedModels: ExtensionContext["scopedModels"];
}

function asThinkingLevel(value: string | undefined): ThinkingLevel | null {
  return value ? value as ThinkingLevel : null;
}

function toGuidanceRequest(options: AgentGuidanceOptions): AgentGuidanceRequest {
  const scopedKeys = scopedModelKeys(options.scopedModels);
  return {
    kind: "assemble-guidance",
    agents: options.agents.map((agent) => ({
      name: agent.name,
      description: agent.description,
      ...(agent.registeredTools ? { registeredTools: [...agent.registeredTools] } : {}),
      ...(agent.maxTurns != null ? { maxTurns: agent.maxTurns } : {}),
    })),
    parentModelKey: options.parentModel ? modelKey(options.parentModel) : "",
    parentThinkingLevel: asThinkingLevel(options.parentThinkingLevel),
    parentSupportedLevels: options.parentModel
      ? getSupportedThinkingLevels(options.parentModel) as ThinkingLevel[]
      : ["off"],
    parentFallbackLevel: options.parentModel
      ? clampThinkingLevel(options.parentModel, "high") as ThinkingLevel
      : "off",
    parentScopedThinkingLevel: options.parentModel
      ? asThinkingLevel(scopedThinkingLevel(options.scopedModels, options.parentModel))
      : null,
    routing: options.routing,
    availableModels: options.availableModels.map((model) => ({
      key: modelKey(model),
      supportedLevels: getSupportedThinkingLevels(model) as ThinkingLevel[],
      fallbackLevel: clampThinkingLevel(model, "high") as ThinkingLevel,
      scopedThinkingLevel: asThinkingLevel(scopedThinkingLevel(options.scopedModels, model)),
    })),
    scopedKeys: scopedKeys ? [...scopedKeys] : null,
  };
}

/** Host translation from Pi session objects into the prompt public seam. */
export function buildCurrentAgentGuidance(options: AgentGuidanceOptions): string {
  const result = assembleAgentGuidance(toGuidanceRequest(options));
  if (!result.ok) throw new TypeError(result.error.message);
  return result.guidance;
}
