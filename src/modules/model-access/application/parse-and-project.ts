import { Check } from "typebox/value";
import {
  ModelAccessFragmentSchema,
  type ModelAccessFragment,
  type ThinkingLevel,
} from "../contracts/model-access-contracts.js";
import {
  applyProviderEnabled as applyProviderEnabledDecision,
  applyRoutingEnabled as applyRoutingEnabledDecision,
  applySelectedModelSnapshot as applySelectedModelSnapshotDecision,
  isParentModelAllowed as isParentModelAllowedDecision,
  parseModelAccessFragment as parseModelAccessFragmentDecision,
  replacementThinkingDefault as replacementThinkingDefaultDecision,
  snapshotVisibleSelectedModels as snapshotVisibleSelectedModelsDecision,
} from "../core/parse-model-access-fragment.js";

function requireFragment(routing: unknown): ModelAccessFragment {
  if (!Check(ModelAccessFragmentSchema, routing)) {
    throw new TypeError("Model access fragment is invalid.");
  }
  return routing;
}

export function parseModelAccessFragment(raw: unknown): ModelAccessFragment {
  return parseModelAccessFragmentDecision(raw);
}

export function applyRoutingEnabled(routing: unknown, enabled: boolean): ModelAccessFragment {
  return applyRoutingEnabledDecision(requireFragment(routing), enabled);
}

export function applyProviderEnabled(
  routing: unknown,
  provider: string,
  enabled: boolean,
): ModelAccessFragment {
  return applyProviderEnabledDecision(requireFragment(routing), provider, enabled);
}

export function isParentModelAllowed(routing: unknown, agentType: string): boolean {
  const fragment = Check(ModelAccessFragmentSchema, routing) ? routing : parseModelAccessFragmentDecision(routing);
  return isParentModelAllowedDecision(fragment, agentType);
}

export function replacementThinkingDefault(
  allowed: readonly ThinkingLevel[],
  fallbackLevel: ThinkingLevel,
): ThinkingLevel {
  return replacementThinkingDefaultDecision(allowed, fallbackLevel);
}

export function snapshotVisibleSelectedModels(visibleModelIds: readonly string[]): string[] {
  return snapshotVisibleSelectedModelsDecision(visibleModelIds);
}

export function applySelectedModelSnapshot(
  routing: unknown,
  agentType: string,
  provider: string,
  visibleModelIds: readonly string[],
): ModelAccessFragment {
  return applySelectedModelSnapshotDecision(requireFragment(routing), agentType, provider, visibleModelIds);
}
