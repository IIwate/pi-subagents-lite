import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRegistry } from "../agents/agent-registry.js";
import { currentModelAccess } from "./model-access.js";
import {
  createParentGuidance,
  type AgentGuidanceResult,
} from "../modules/prompt/public.js";
import { parseThinkingLevel } from "../utils.js";
import { piGuidanceHost } from "../platform/pi/agent-guidance-request.js";

export function createParentGuidanceRuntime(registry: AgentRegistry) {
  const guidance = createParentGuidance({
    catalogue: {
      listAgents() {
        return registry.availableTypes().flatMap((name) => {
          const config = registry.agentConfig(name);
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
      return guidance.assemble(piGuidanceHost({
        parentModel: ctx.model,
        parentThinkingLevel: parseThinkingLevel(ctx.thinkingLevel),
        routing: currentModelAccess(),
        availableModels: ctx.modelRegistry.getAvailable(),
        scopedModels: ctx.scopedModels,
      }));
    },
  };
}
