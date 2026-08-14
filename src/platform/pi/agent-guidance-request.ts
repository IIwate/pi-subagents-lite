/**
 * agent-guidance-request.ts — Translate Pi session objects into the prompt
 * module's guidance request.
 *
 * Thinking capability lives in Pi's compat helpers, and the scope snapshot
 * lives on ExtensionContext, so the translation is a host concern. Keeping it
 * here means the guidance contract itself stays free of vendor model objects.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type {
  AgentGuidanceRequest,
  ParentGuidanceHostSnapshot,
} from "../../modules/prompt/public.js";
import type { ModelAccessFragment, ThinkingLevel } from "../../modules/model-access/public.js";
import { modelKey, scopedModelKeys, scopedThinkingLevel } from "../../models/model-scope.js";

export interface AgentGuidanceOptions {
  parentModel: Model<any> | undefined;
  parentThinkingLevel: ThinkingLevel | undefined;
  routing: Readonly<ModelAccessFragment>;
  availableModels: readonly Model<any>[];
  scopedModels: ExtensionContext["scopedModels"];
}

function asThinkingLevel(value: string | undefined): ThinkingLevel | null {
  return value ? value as ThinkingLevel : null;
}

/** Project one Pi model onto the guidance contract's model capability shape. */
export function piModelCapability(
  model: Model<any>,
  scopedModels: ExtensionContext["scopedModels"],
): AgentGuidanceRequest["availableModels"][number] {
  return {
    key: modelKey(model),
    supportedLevels: getSupportedThinkingLevels(model) as ThinkingLevel[],
    fallbackLevel: clampThinkingLevel(model, "high") as ThinkingLevel,
    scopedThinkingLevel: asThinkingLevel(scopedThinkingLevel(scopedModels, model)),
  };
}

/** Build the guidance host snapshot from a Pi session's models, scope, and routing. */
export function piGuidanceHost(options: AgentGuidanceOptions): ParentGuidanceHostSnapshot {
  const scopedKeys = scopedModelKeys(options.scopedModels);
  const parentCapability = options.parentModel
    ? piModelCapability(options.parentModel, options.scopedModels)
    : undefined;
  return {
    parentModelKey: parentCapability?.key ?? "",
    parentThinkingLevel: asThinkingLevel(options.parentThinkingLevel),
    parentSupportedLevels: parentCapability?.supportedLevels ?? ["off"],
    parentFallbackLevel: parentCapability?.fallbackLevel ?? "off",
    parentScopedThinkingLevel: parentCapability?.scopedThinkingLevel ?? null,
    routing: options.routing,
    availableModels: options.availableModels.map(
      (model) => piModelCapability(model, options.scopedModels),
    ),
    scopedKeys: scopedKeys ? [...scopedKeys] : null,
  };
}
