import type { AgentModelAccess, ModelAccessFragment, ThinkingLevel } from "../contracts/model-access-contracts.js";

const CANONICAL_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

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

export function applyThinkingAccess(
  routing: ModelAccessFragment,
  agentType: string,
  modelKey: string,
  allowed: readonly string[],
  defaultLevel: string,
): ModelAccessFragment {
  const typeKey = agentType.trim();
  const key = modelKey.trim();
  const slash = key.indexOf("/");
  const normalized = [...new Set(allowed.filter((level): level is ThinkingLevel => CANONICAL_LEVELS.has(level as ThinkingLevel)))];
  const next = structuredClone(routing);
  if (!typeKey || slash <= 0 || slash === key.length - 1 || normalized.length === 0 || !normalized.includes(defaultLevel as ThinkingLevel)) {
    return next;
  }
  const access = ownValue(next.agentAccess, typeKey) ?? { providers: {} };
  if (!Object.hasOwn(next.agentAccess, typeKey)) setOwn(next.agentAccess, typeKey, access);
  const thinking = access.thinking ?? {};
  if (!access.thinking) access.thinking = thinking;
  setOwn(thinking, key, { allowed: normalized, default: defaultLevel as ThinkingLevel });
  return next;
}

export function applyResetThinkingAccess(
  routing: ModelAccessFragment,
  agentType: string,
  modelKey: string,
): ModelAccessFragment {
  const typeKey = agentType.trim();
  const key = modelKey.trim();
  const next = structuredClone(routing);
  const access = ownValue(next.agentAccess, typeKey);
  if (!access?.thinking || !Object.hasOwn(access.thinking, key)) return next;
  delete access.thinking[key];
  if (Object.keys(access.thinking).length === 0) delete access.thinking;
  pruneAgentAccess(next.agentAccess, typeKey);
  return next;
}

export function applyDeleteProviderRules(
  routing: ModelAccessFragment,
  provider: string,
): ModelAccessFragment {
  const next = structuredClone(routing);
  for (const type of Object.keys(next.agentAccess)) {
    const access = next.agentAccess[type];
    delete access.providers[provider];
    for (const key of Object.keys(access.thinking ?? {})) {
      if (key.startsWith(`${provider}/`)) delete access.thinking![key];
    }
    if (access.thinking && Object.keys(access.thinking).length === 0) delete access.thinking;
    pruneAgentAccess(next.agentAccess, type);
  }
  return next;
}

export function applyCleanUnavailableModels(
  routing: ModelAccessFragment,
  provider: string,
  modelIds: readonly string[],
): ModelAccessFragment {
  const next = structuredClone(routing);
  const stale = new Set(modelIds);
  for (const type of Object.keys(next.agentAccess)) {
    const access = next.agentAccess[type];
    const rule = ownValue(access.providers, provider);
    if (!rule?.models) continue;
    const removed = rule.models.filter((modelId) => stale.has(modelId));
    if (removed.length === 0) continue;
    rule.models = rule.models.filter((modelId) => !stale.has(modelId));
    if (rule.models.length === 0) delete access.providers[provider];
    for (const modelId of removed) delete access.thinking?.[`${provider}/${modelId}`];
    if (access.thinking && Object.keys(access.thinking).length === 0) delete access.thinking;
    pruneAgentAccess(next.agentAccess, type);
  }
  return next;
}

export function applyClearModelAccess(): ModelAccessFragment {
  return { enabled: false, enabledProviders: [], agentAccess: {} };
}
