import type { ModelAccessFragment } from "../contracts/model-access-contracts.js";

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

export function listAgentTypesForProvider(
  routing: ModelAccessFragment,
  provider: string,
): string[] {
  const prefix = `${provider}/`;
  return Object.entries(routing.agentAccess)
    .filter(([, access]) =>
      Object.hasOwn(access.providers, provider)
      || Object.keys(access.thinking ?? {}).some((key) => key.startsWith(prefix)),
    )
    .map(([type]) => type)
    .sort();
}

export function listUnavailableModelRules(input: {
  routing: ModelAccessFragment;
  provider: string;
  catalogueModelIds: readonly string[];
  providerPresent: boolean;
  registryReliable: boolean;
}): Record<string, string[]> {
  const { routing, provider, catalogueModelIds, providerPresent, registryReliable } = input;
  if (!providerPresent || !registryReliable) return {};

  const catalogue = new Set(catalogueModelIds);
  const result: Record<string, string[]> = {};
  for (const type of Object.keys(routing.agentAccess).sort()) {
    const models = ownValue(routing.agentAccess[type].providers, provider)?.models;
    if (!models) continue;
    const missing = models.filter((modelId) => !catalogue.has(modelId)).sort();
    if (missing.length > 0) setOwn(result, type, missing);
  }
  return result;
}
