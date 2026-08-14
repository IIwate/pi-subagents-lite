import {
  CANONICAL_THINKING_LEVELS,
  type AgentModelAccess,
  type ModelAccessFragment,
  type ProviderModelAccess,
  type ThinkingAccessOverride,
  type ThinkingLevel,
} from "../contracts/model-access-contracts.js";

const CANONICAL_LEVELS = new Set<ThinkingLevel>(CANONICAL_THINKING_LEVELS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== "string") return undefined;
  const level = value.trim();
  return CANONICAL_LEVELS.has(level as ThinkingLevel) ? level as ThinkingLevel : undefined;
}

function normalizeModelKey(value: string): string | undefined {
  const key = value.trim();
  const slash = key.indexOf("/");
  return slash > 0 && slash < key.length - 1 ? key : undefined;
}

function mergeThinkingOverride(
  existing: ThinkingAccessOverride,
  incoming: ThinkingAccessOverride,
): ThinkingAccessOverride {
  const incomingAllowed = new Set(incoming.allowed);
  const allowed = existing.allowed.filter((level) => incomingAllowed.has(level));
  if (allowed.length === 0) return existing;
  const defaultLevel = allowed.includes(existing.default)
    ? existing.default
    : allowed.includes(incoming.default)
      ? incoming.default
      : allowed[0];
  return { allowed, default: defaultLevel };
}

function normalizeThinkingOverrides(raw: unknown): Record<string, ThinkingAccessOverride> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const thinking: Record<string, ThinkingAccessOverride> = {};
  for (const [rawKey, rawOverride] of Object.entries(raw)) {
    const key = normalizeModelKey(rawKey);
    if (!key || !isPlainObject(rawOverride) || !Array.isArray(rawOverride.allowed)) continue;
    const allowed = [...new Set(rawOverride.allowed
      .map(normalizeThinkingLevel)
      .filter((level): level is ThinkingLevel => level !== undefined))];
    const defaultLevel = normalizeThinkingLevel(rawOverride.default);
    if (allowed.length === 0 || !defaultLevel || !allowed.includes(defaultLevel)) continue;
    const normalized = { allowed, default: defaultLevel };
    const existing = Object.hasOwn(thinking, key) ? thinking[key] : undefined;
    setOwn(thinking, key, existing ? mergeThinkingOverride(existing, normalized) : normalized);
  }
  return Object.keys(thinking).length > 0 ? thinking : undefined;
}

function mergeProviderRule(
  existing: ProviderModelAccess,
  incoming: ProviderModelAccess,
): ProviderModelAccess | undefined {
  if (!existing.models) return incoming.models ? { models: [...incoming.models] } : {};
  if (!incoming.models) return { models: [...existing.models] };
  const incomingModels = new Set(incoming.models);
  const models = existing.models.filter((model) => incomingModels.has(model));
  return models.length > 0 ? { models } : undefined;
}

export function parseModelAccessFragment(raw: unknown): ModelAccessFragment {
  if (!isPlainObject(raw)) return { enabled: false, enabledProviders: [], agentAccess: {} };

  const enabledProviders: string[] = [];
  if (Array.isArray(raw.enabledProviders)) {
    const seen = new Set<string>();
    for (const value of raw.enabledProviders) {
      if (typeof value !== "string") continue;
      const provider = value.trim();
      if (!provider || seen.has(provider)) continue;
      seen.add(provider);
      enabledProviders.push(provider);
    }
  }

  const agentAccess: Record<string, AgentModelAccess> = {};
  const blockedProviders = new Map<string, Set<string>>();
  if (isPlainObject(raw.agentAccess)) {
    for (const [rawType, rawAccess] of Object.entries(raw.agentAccess)) {
      const type = rawType.trim();
      if (!type || !isPlainObject(rawAccess)) continue;

      const existing = Object.hasOwn(agentAccess, type) ? agentAccess[type] : undefined;
      const access = existing ?? { providers: {} };
      const blocked = blockedProviders.get(type) ?? new Set<string>();
      blockedProviders.set(type, blocked);

      if (isPlainObject(rawAccess.providers)) {
        for (const [rawProvider, rawProviderAccess] of Object.entries(rawAccess.providers)) {
          const provider = rawProvider.trim();
          if (!provider || blocked.has(provider) || !isPlainObject(rawProviderAccess)) continue;
          let normalized: ProviderModelAccess | undefined;
          if (!Object.hasOwn(rawProviderAccess, "models")) {
            if (Object.keys(rawProviderAccess).length === 0) normalized = {};
          } else if (Array.isArray(rawProviderAccess.models)) {
            const models = [...new Set(rawProviderAccess.models
              .filter((model): model is string => typeof model === "string")
              .map((model) => model.trim())
              .filter(Boolean))];
            if (models.length > 0) normalized = { models };
          }
          if (!normalized) continue;
          if (!Object.hasOwn(access.providers, provider)) {
            setOwn(access.providers, provider, normalized);
            continue;
          }
          const merged = mergeProviderRule(access.providers[provider], normalized);
          if (merged) {
            setOwn(access.providers, provider, merged);
          } else {
            delete access.providers[provider];
            blocked.add(provider);
          }
        }
      }
      if (rawAccess.parentModelAccess === false) access.parentModelAccess = false;
      const thinking = normalizeThinkingOverrides(rawAccess.thinking);
      if (thinking) {
        const mergedThinking = access.thinking ?? {};
        for (const [key, override] of Object.entries(thinking)) {
          const saved = Object.hasOwn(mergedThinking, key) ? mergedThinking[key] : undefined;
          setOwn(mergedThinking, key, saved ? mergeThinkingOverride(saved, override) : override);
        }
        access.thinking = mergedThinking;
      }
      if (
        Object.keys(access.providers).length > 0
        || access.parentModelAccess === false
        || Object.keys(access.thinking ?? {}).length > 0
      ) {
        if (!existing) setOwn(agentAccess, type, access);
      } else if (existing) {
        delete agentAccess[type];
      }
    }
  }

  return { enabled: raw.enabled === true, enabledProviders, agentAccess };
}

export function applyRoutingEnabled(routing: ModelAccessFragment, enabled: boolean): ModelAccessFragment {
  const next = structuredClone(routing);
  next.enabled = enabled;
  return next;
}

export function applyProviderEnabled(
  routing: ModelAccessFragment,
  provider: string,
  enabled: boolean,
): ModelAccessFragment {
  const key = provider.trim();
  const next = structuredClone(routing);
  if (!key) return next;
  const providers = new Set(next.enabledProviders);
  if (enabled) providers.add(key);
  else providers.delete(key);
  next.enabledProviders = [...providers];
  return next;
}

export function isParentModelAllowed(routing: ModelAccessFragment, agentType: string): boolean {
  return routing.agentAccess[agentType]?.parentModelAccess !== false;
}

export function replacementThinkingDefault(
  allowed: readonly ThinkingLevel[],
  fallbackLevel: ThinkingLevel,
): ThinkingLevel {
  const order = CANONICAL_THINKING_LEVELS;
  const preferredIndex = order.indexOf(fallbackLevel);
  const start = preferredIndex === -1 ? 0 : preferredIndex;
  for (let index = start; index < order.length; index++) {
    if (allowed.includes(order[index])) return order[index];
  }
  for (let index = start - 1; index >= 0; index--) {
    if (allowed.includes(order[index])) return order[index];
  }
  return allowed[0] ?? fallbackLevel;
}

export function snapshotVisibleSelectedModels(visibleModelIds: readonly string[]): string[] {
  return [...new Set(visibleModelIds.map((id) => id.trim()).filter(Boolean))];
}

export function applySelectedModelSnapshot(
  routing: ModelAccessFragment,
  agentType: string,
  provider: string,
  visibleModelIds: readonly string[],
): ModelAccessFragment {
  const next = structuredClone(routing);
  const access = next.agentAccess[agentType];
  if (!access) return next;
  const models = [...new Set(visibleModelIds.map((id) => id.trim()).filter(Boolean))];
  if (models.length === 0) {
    delete access.providers[provider];
    if (
      Object.keys(access.providers).length === 0
      && access.parentModelAccess === undefined
      && Object.keys(access.thinking ?? {}).length === 0
    ) {
      delete next.agentAccess[agentType];
    }
    return next;
  }
  access.providers[provider] = { models };
  return next;
}
