/** Pure Agent model-access policy helpers. */

import type { ModelRoutingConfig, ProviderModelAccess } from "../config/types.js";

export type ModelAuthorizationVerdict =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "routing-disabled"
        | "provider-disabled"
        | "agent-provider-denied"
        | "model-denied"
        | "model-unavailable"
        | "out-of-scope";
    };

export interface ModelAuthorizationContext {
  agentType: string;
  modelKey: string;
  parentModelKey: string;
  routing: Readonly<ModelRoutingConfig>;
  availableKeys: ReadonlySet<string>;
  scopedKeys: ReadonlySet<string> | null;
}

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

function providerFromModelKey(key: string): string {
  const slash = key.indexOf("/");
  return slash > 0 ? key.slice(0, slash) : "";
}

function providerPassesGlobalGate(
  provider: string,
  routing: Readonly<ModelRoutingConfig>,
  parentModelKey: string,
): boolean {
  return provider === providerFromModelKey(parentModelKey)
    || routing.enabledProviders.includes(provider);
}

/** Authorize one already-resolved model key for a new Agent invocation. */
export function authorizeModel(ctx: ModelAuthorizationContext): ModelAuthorizationVerdict {
  const { agentType, modelKey, parentModelKey, routing, availableKeys, scopedKeys } = ctx;

  // The exact parent is the only implicit capability and remains valid even
  // when routing, provider access, or the active scope changes around it.
  if (parentModelKey && modelKey === parentModelKey) return { ok: true };
  if (!routing.enabled) return { ok: false, reason: "routing-disabled" };

  const slash = modelKey.indexOf("/");
  if (slash <= 0) return { ok: false, reason: "model-unavailable" };
  const provider = modelKey.slice(0, slash);
  const modelId = modelKey.slice(slash + 1);

  if (!providerPassesGlobalGate(provider, routing, parentModelKey)) {
    return { ok: false, reason: "provider-disabled" };
  }
  const agentAccess = ownValue(routing.agentAccess, agentType);
  const access = agentAccess ? ownValue(agentAccess.providers, provider) : undefined;
  if (!access) return { ok: false, reason: "agent-provider-denied" };
  if (access.models && !access.models.includes(modelId)) {
    return { ok: false, reason: "model-denied" };
  }
  if (!availableKeys.has(modelKey)) return { ok: false, reason: "model-unavailable" };
  if (scopedKeys && !scopedKeys.has(modelKey)) return { ok: false, reason: "out-of-scope" };
  return { ok: true };
}

/** Effective alternate keys advertised to the parent LLM for one agent type. */
export function effectiveAlternateModelKeys(
  agentType: string,
  routing: Readonly<ModelRoutingConfig>,
  availableKeys: ReadonlySet<string>,
  scopedKeys: ReadonlySet<string> | null,
  parentModelKey = "",
): string[] {
  if (!routing.enabled) return [];
  const rules = ownValue(routing.agentAccess, agentType)?.providers;
  if (!rules) return [];

  const result: string[] = [];
  for (const provider of Object.keys(rules).sort()) {
    if (!providerPassesGlobalGate(provider, routing, parentModelKey)) continue;
    const access = ownValue(rules, provider)!;
    const keys = access.models
      ? access.models.map((modelId) => `${provider}/${modelId}`)
      : [...availableKeys].filter((key) => key.startsWith(`${provider}/`));
    for (const key of keys) {
      if (key === parentModelKey || !availableKeys.has(key)) continue;
      if (scopedKeys && !scopedKeys.has(key)) continue;
      result.push(key);
    }
  }
  return [...new Set(result)].sort();
}

/** Agent types with a saved rule for one provider, including unavailable agents. */
export function agentTypesForProvider(
  routing: Readonly<ModelRoutingConfig>,
  provider: string,
): string[] {
  return Object.entries(routing.agentAccess)
    .filter(([, access]) => Object.hasOwn(access.providers, provider))
    .map(([type]) => type)
    .sort();
}

/** Exact IDs eligible for reliable catalogue cleanup, grouped by agent type. */
export function unavailableModelRules(
  routing: Readonly<ModelRoutingConfig>,
  provider: string,
  catalogueModelIds: ReadonlySet<string>,
  providerPresent: boolean,
  registryReliable: boolean,
): Record<string, string[]> {
  if (!providerPresent || !registryReliable) return {};

  const result: Record<string, string[]> = {};
  for (const type of Object.keys(routing.agentAccess).sort()) {
    const models = ownValue(routing.agentAccess[type].providers, provider)?.models;
    if (!models) continue;
    const missing = models.filter((modelId) => !catalogueModelIds.has(modelId)).sort();
    if (missing.length > 0) setOwn(result, type, missing);
  }
  return result;
}

export function accessSummary(access: ProviderModelAccess): string {
  return access.models ? `${access.models.length} model${access.models.length === 1 ? "" : "s"}` : "All models";
}
