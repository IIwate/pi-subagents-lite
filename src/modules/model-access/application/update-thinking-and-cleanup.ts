import { Check } from "typebox/value";
import {
  ModelAccessFragmentSchema,
  type ModelAccessFragment,
} from "../contracts/model-access-contracts.js";
import {
  applyCleanUnavailableModels as applyCleanUnavailableModelsDecision,
  applyClearModelAccess as applyClearModelAccessDecision,
  applyDeleteProviderRules as applyDeleteProviderRulesDecision,
  applyResetThinkingAccess as applyResetThinkingAccessDecision,
  applyThinkingAccess as applyThinkingAccessDecision,
} from "../core/update-thinking-and-cleanup.js";

function requireFragment(routing: unknown): ModelAccessFragment {
  if (!Check(ModelAccessFragmentSchema, routing)) {
    throw new TypeError("Model access fragment is invalid.");
  }
  return routing;
}

export function applyThinkingAccess(
  routing: unknown,
  agentType: string,
  modelKey: string,
  allowed: readonly string[],
  defaultLevel: string,
): ModelAccessFragment {
  return applyThinkingAccessDecision(requireFragment(routing), agentType, modelKey, allowed, defaultLevel);
}

export function applyResetThinkingAccess(
  routing: unknown,
  agentType: string,
  modelKey: string,
): ModelAccessFragment {
  return applyResetThinkingAccessDecision(requireFragment(routing), agentType, modelKey);
}

export function applyDeleteProviderRules(routing: unknown, provider: string): ModelAccessFragment {
  return applyDeleteProviderRulesDecision(requireFragment(routing), provider);
}

export function applyCleanUnavailableModels(
  routing: unknown,
  provider: string,
  modelIds: readonly string[],
): ModelAccessFragment {
  return applyCleanUnavailableModelsDecision(requireFragment(routing), provider, modelIds);
}

export function applyClearModelAccess(): ModelAccessFragment {
  return applyClearModelAccessDecision();
}
