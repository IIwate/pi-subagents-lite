import { Check } from "typebox/value";
import {
  ModelAccessFragmentSchema,
  ResolveThinkingAccessQuerySchema,
  ThinkingAccessPolicySchema,
  type ModelAccessFragment,
  type ResolveThinkingAccessQuery,
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

function asThinkingQuery(input: unknown): ResolveThinkingAccessQuery | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const query = {
    routing: raw.routing,
    agentType: raw.agentType,
    modelKey: raw.modelKey,
    parentModelKey: raw.parentModelKey,
    supportedLevels: raw.supportedLevels,
    fallbackLevel: raw.fallbackLevel,
    ...(raw.parentThinkingLevel !== undefined ? { parentThinkingLevel: raw.parentThinkingLevel } : {}),
    ...(raw.scopedThinkingLevel !== undefined ? { scopedThinkingLevel: raw.scopedThinkingLevel } : {}),
  };
  return Check(ResolveThinkingAccessQuerySchema, query) ? query : undefined;
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
  const query = asThinkingQuery(input);
  if (!query) return null;
  const fragment = asFragment(query.routing);
  const override = fragment
    ? fragment.agentAccess[query.agentType]?.thinking?.[query.modelKey]
    : undefined;
  const policy = decideThinkingAccess({
    modelKey: query.modelKey,
    parentModelKey: query.parentModelKey,
    parentThinkingLevel: query.parentThinkingLevel,
    scopedThinkingLevel: query.scopedThinkingLevel,
    supportedLevels: query.supportedLevels,
    fallbackLevel: query.fallbackLevel,
    override,
  });
  if (policy !== null && !Check(ThinkingAccessPolicySchema, policy)) return null;
  return policy;
}

export function selectThinkingLevel(
  policy: Readonly<ThinkingAccessPolicy>,
  requested: string | undefined,
): ThinkingSelection {
  return decideThinkingSelection(policy, requested);
}
