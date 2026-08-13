import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentConfig, getAvailableTypes } from "../agents/agent-types.js";
import { currentModelAccess } from "./model-access.js";
import {
  createParentGuidance,
  type AgentGuidanceResult,
} from "../modules/prompt/public.js";
import type { ThinkingLevel } from "../modules/model-access/public.js";
import { modelKey, scopedModelKeys, scopedThinkingLevel } from "../models/model-scope.js";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";

function asThinkingLevel(value: string | undefined): ThinkingLevel | null {
  return value ? value as ThinkingLevel : null;
}

export function createParentGuidanceRuntime() {
  const guidance = createParentGuidance({
    catalogue: {
      listAgents() {
        return getAvailableTypes().flatMap((name) => {
          const config = getAgentConfig(name);
          return config
            ? [{
                name,
                description: config.description,
                registeredTools: config.registeredTools,
                maxTurns: config.maxTurns,
              }]
            : [];
        });
      },
    },
  });

  return {
    assembleFromSession(ctx: ExtensionContext): AgentGuidanceResult {
      const scopedKeys = scopedModelKeys(ctx.scopedModels);
      return guidance.assemble({
        parentModelKey: ctx.model ? modelKey(ctx.model) : "",
        parentThinkingLevel: asThinkingLevel(ctx.thinkingLevel),
        parentSupportedLevels: ctx.model
          ? getSupportedThinkingLevels(ctx.model) as ThinkingLevel[]
          : ["off"],
        parentFallbackLevel: ctx.model
          ? clampThinkingLevel(ctx.model, "high") as ThinkingLevel
          : "off",
        parentScopedThinkingLevel: ctx.model
          ? asThinkingLevel(scopedThinkingLevel(ctx.scopedModels, ctx.model))
          : null,
        routing: currentModelAccess(),
        availableModels: ctx.modelRegistry.getAvailable().map((model: Model<any>) => ({
          key: modelKey(model),
          supportedLevels: getSupportedThinkingLevels(model) as ThinkingLevel[],
          fallbackLevel: clampThinkingLevel(model, "high") as ThinkingLevel,
          scopedThinkingLevel: asThinkingLevel(scopedThinkingLevel(ctx.scopedModels, model)),
        })),
        scopedKeys: scopedKeys ? [...scopedKeys] : null,
      });
    },
  };
}
