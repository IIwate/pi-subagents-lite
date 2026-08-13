import type { AgentModelAccess, ModelAccessFragment } from "../contracts/model-access-contracts.js";

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

function pruneAgentAccess(
  agentAccess: Record<string, AgentModelAccess>,
  type: string,
): void {
  const access = ownValue(agentAccess, type);
  if (
    access
    && Object.keys(access.providers).length === 0
    && access.parentModelAccess === undefined
    && Object.keys(access.thinking ?? {}).length === 0
  ) {
    delete agentAccess[type];
  }
}

function writeAgentProviderAccess(
  routing: ModelAccessFragment,
  type: string,
  provider: string,
  models: readonly string[] | undefined,
): void {
  const normalized = models === undefined
    ? undefined
    : [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  const existing = ownValue(routing.agentAccess, type);
  if (normalized?.length === 0) {
    if (existing) delete existing.providers[provider];
    pruneAgentAccess(routing.agentAccess, type);
    return;
  }
  const agent = existing ?? { providers: {} };
  if (!existing) setOwn(routing.agentAccess, type, agent);
  setOwn(agent.providers, provider, normalized ? { models: normalized } : {});
}

export function applyAgentProviderAccess(
  routing: ModelAccessFragment,
  agentType: string,
  provider: string,
  models?: readonly string[],
): ModelAccessFragment {
  const typeKey = agentType.trim();
  const providerKey = provider.trim();
  const next = structuredClone(routing);
  if (!typeKey || !providerKey) return next;
  writeAgentProviderAccess(next, typeKey, providerKey, models);
  return next;
}

export function applyQuickAgentProviderAccess(
  routing: ModelAccessFragment,
  agentType: string,
  provider: string,
  models?: readonly string[],
): ModelAccessFragment {
  const typeKey = agentType.trim();
  const key = provider.trim();
  const normalized = models === undefined
    ? undefined
    : [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  if (!typeKey || !key || normalized?.length === 0) return structuredClone(routing);

  const next = structuredClone(routing);
  next.enabled = true;
  next.enabledProviders = [...new Set([...next.enabledProviders, key])];
  writeAgentProviderAccess(next, typeKey, key, normalized);
  return next;
}
