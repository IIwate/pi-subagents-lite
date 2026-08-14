import { Check } from "typebox/value";
import {
  ModelAccessFragmentSchema,
  type ModelAccessFragment,
} from "../contracts/model-access-contracts.js";
import { listEffectiveAlternateKeys } from "../core/effective-alternates.js";
import { listAgentTypesForProvider, listUnavailableModelRules } from "../core/provider-rules.js";
import { decideThinkingAccess, decideThinkingSelection } from "../core/thinking-access.js";
import type {
  ThinkingAccessPolicy,
  ThinkingLevel,
  ThinkingSelection,
} from "../contracts/model-access-contracts.js";

function asFragment(routing: unknown): ModelAccessFragment | undefined {
  return Check(ModelAccessFragmentSchema, routing) ? routing : undefined;
}

export function effectiveAlternateModelKeys(
  agentType: string,
  routing: unknown,
  availableKeys: readonly string[],
  scopedKeys: readonly string[] | null,
  parentModelKey = "",
): string[] {
  const fragment = asFragment(routing);
  if (!fragment) return [];
  return listEffectiveAlternateKeys({
    agentType,
    routing: fragment,
    availableKeys,
    scopedKeys,
    parentModelKey,
  });
}

export function agentTypesForProvider(routing: unknown, provider: string): string[] {
  const fragment = asFragment(routing);
  return fragment ? listAgentTypesForProvider(fragment, provider) : [];
}

export function unavailableModelRules(
  routing: unknown,
  provider: string,
  // Serializable list, not a Set: the public surface must survive a JSON hop,
  // and the caller's uniqueness guarantee is not something this module needs.
  catalogueModelIds: readonly string[],
  providerPresent: boolean,
  registryReliable: boolean,
): Record<string, string[]> {
  const fragment = asFragment(routing);
  if (!fragment) return {};
  return listUnavailableModelRules({
    routing: fragment,
    provider,
    catalogueModelIds,
    providerPresent,
    registryReliable,
  });
}

export function resolveThinkingAccess(input: {
  routing: unknown;
  agentType: string;
  modelKey: string;
  parentModelKey: string;
  parentThinkingLevel: string | undefined;
  scopedThinkingLevel: string | undefined;
  supportedLevels: readonly ThinkingLevel[];
  fallbackLevel: ThinkingLevel;
}): ThinkingAccessPolicy | null {
  const fragment = asFragment(input.routing);
  const override = fragment
    ? fragment.agentAccess[input.agentType]?.thinking?.[input.modelKey]
    : undefined;
  return decideThinkingAccess({
    modelKey: input.modelKey,
    parentModelKey: input.parentModelKey,
    parentThinkingLevel: input.parentThinkingLevel,
    scopedThinkingLevel: input.scopedThinkingLevel,
    supportedLevels: input.supportedLevels,
    fallbackLevel: input.fallbackLevel,
    override,
  });
}

export function selectThinkingLevel(
  policy: Readonly<ThinkingAccessPolicy>,
  requested: string | undefined,
): ThinkingSelection {
  return decideThinkingSelection(policy, requested);
}
