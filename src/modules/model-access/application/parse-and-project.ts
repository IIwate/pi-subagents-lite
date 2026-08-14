import { Check } from "typebox/value";
import {
  ModelAccessFragmentSchema,
  type ModelAccessFragment,
  type ThinkingLevel,
} from "../contracts/model-access-contracts.js";
import { outboundFragment, requireFragment } from "./checked-fragment.js";
import {
  applyProviderEnabled as applyProviderEnabledDecision,
  applyRoutingEnabled as applyRoutingEnabledDecision,
  applySelectedModelSnapshot as applySelectedModelSnapshotDecision,
  isParentModelAllowed as isParentModelAllowedDecision,
  parseModelAccessFragment as parseModelAccessFragmentDecision,
  replacementThinkingDefault as replacementThinkingDefaultDecision,
  snapshotVisibleSelectedModels as snapshotVisibleSelectedModelsDecision,
} from "../core/parse-model-access-fragment.js";

export function parseModelAccessFragment(raw: unknown): ModelAccessFragment {
  return outboundFragment(parseModelAccessFragmentDecision(raw));
}

export function applyRoutingEnabled(routing: unknown, enabled: boolean): ModelAccessFragment {
  return outboundFragment(applyRoutingEnabledDecision(requireFragment(routing), enabled));
}

export function applyProviderEnabled(
  routing: unknown,
  provider: string,
  enabled: boolean,
): ModelAccessFragment {
  return outboundFragment(applyProviderEnabledDecision(requireFragment(routing), provider, enabled));
}

export function isParentModelAllowed(routing: unknown, agentType: string): boolean {
  const fragment = Check(ModelAccessFragmentSchema, routing) ? routing : parseModelAccessFragment(routing);
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
  return outboundFragment(
    applySelectedModelSnapshotDecision(requireFragment(routing), agentType, provider, visibleModelIds),
  );
}
