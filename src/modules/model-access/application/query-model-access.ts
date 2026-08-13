import { Check } from "typebox/value";
import {
  ModelAccessFragmentSchema,
  type ModelAccessFragment,
} from "../contracts/model-access-contracts.js";
import { listEffectiveAlternateKeys } from "../core/effective-alternates.js";
import { listAgentTypesForProvider, listUnavailableModelRules } from "../core/provider-rules.js";
import {
  decideThinkingAccess,
  decideThinkingSelection,
  type ThinkingAccessPolicy,
  type ThinkingSelection,
} from "../core/thinking-access.js";
import type { ThinkingAccessOverride, ThinkingLevel } from "../contracts/model-access-contracts.js";

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
  catalogueModelIds: ReadonlySet<string>,
  providerPresent: boolean,
  registryReliable: boolean,
): Record<string, string[]> {
  const fragment = asFragment(routing);
  if (!fragment) return {};
  return listUnavailableModelRules({
    routing: fragment,
    provider,
    catalogueModelIds: [...catalogueModelIds],
    providerPresent,
    registryReliable,
  });
}

export function resolveThinkingAccess(input: {
  modelKey: string;
  parentModelKey: string;
  parentThinkingLevel: string | undefined;
  scopedThinkingLevel: string | undefined;
  supportedLevels: readonly ThinkingLevel[];
  fallbackLevel: ThinkingLevel;
  override: ThinkingAccessOverride | undefined;
}): ThinkingAccessPolicy | null {
  return decideThinkingAccess(input);
}

export function selectThinkingLevel(
  policy: Readonly<ThinkingAccessPolicy>,
  requested: string | undefined,
): ThinkingSelection {
  return decideThinkingSelection(policy, requested);
}

export type { ThinkingAccessPolicy, ThinkingSelection };
