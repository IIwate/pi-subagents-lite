import type { ModelAccessFragment } from "../contracts/model-access-contracts.js";

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function listEffectiveAlternateKeys(input: {
  agentType: string;
  routing: ModelAccessFragment;
  availableKeys: readonly string[];
  scopedKeys: readonly string[] | null;
  parentModelKey: string;
}): string[] {
  const { agentType, routing, availableKeys, scopedKeys, parentModelKey } = input;
  if (!routing.enabled) return [];
  const rules = ownValue(routing.agentAccess, agentType)?.providers;
  if (!rules) return [];

  const available = new Set(availableKeys);
  const scoped = scopedKeys ? new Set(scopedKeys) : null;
  const result: string[] = [];
  for (const provider of Object.keys(rules).sort()) {
    if (!routing.enabledProviders.includes(provider)) continue;
    const access = ownValue(rules, provider)!;
    const keys = access.models
      ? access.models.map((modelId) => `${provider}/${modelId}`)
      : [...available].filter((key) => key.startsWith(`${provider}/`));
    for (const key of keys) {
      if (key === parentModelKey || !available.has(key)) continue;
      if (scoped && !scoped.has(key)) continue;
      result.push(key);
    }
  }
  return [...new Set(result)].sort();
}
