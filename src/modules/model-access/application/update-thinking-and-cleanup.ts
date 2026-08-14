import { type ModelAccessFragment } from "../contracts/model-access-contracts.js";
import { outboundFragment, requireFragment } from "./checked-fragment.js";
import {
  applyCleanUnavailableModels as applyCleanUnavailableModelsDecision,
  applyClearModelAccess as applyClearModelAccessDecision,
  applyDeleteProviderRules as applyDeleteProviderRulesDecision,
  applyResetThinkingAccess as applyResetThinkingAccessDecision,
  applyThinkingAccess as applyThinkingAccessDecision,
} from "../core/update-thinking-and-cleanup.js";

export function applyThinkingAccess(
  routing: unknown,
  agentType: string,
  modelKey: string,
  allowed: readonly string[],
  defaultLevel: string,
): ModelAccessFragment {
  return outboundFragment(
    applyThinkingAccessDecision(requireFragment(routing), agentType, modelKey, allowed, defaultLevel),
  );
}

export function applyResetThinkingAccess(
  routing: unknown,
  agentType: string,
  modelKey: string,
): ModelAccessFragment {
  return outboundFragment(applyResetThinkingAccessDecision(requireFragment(routing), agentType, modelKey));
}

export function applyDeleteProviderRules(routing: unknown, provider: string): ModelAccessFragment {
  return outboundFragment(applyDeleteProviderRulesDecision(requireFragment(routing), provider));
}

export function applyCleanUnavailableModels(
  routing: unknown,
  provider: string,
  modelIds: readonly string[],
): ModelAccessFragment {
  return outboundFragment(applyCleanUnavailableModelsDecision(requireFragment(routing), provider, modelIds));
}

export function applyClearModelAccess(): ModelAccessFragment {
  return outboundFragment(applyClearModelAccessDecision());
}
