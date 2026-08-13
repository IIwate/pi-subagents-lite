import type {
  AuthorizationDenialReason,
  AuthorizeModelCommand,
} from "../contracts/model-access-contracts.js";

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function decideModelAuthorization(
  command: AuthorizeModelCommand,
): { ok: true } | { ok: false; reason: AuthorizationDenialReason } {
  const { agentType, modelKey, parentModelKey, routing, availableKeys, scopedKeys } = command;
  const available = new Set(availableKeys);
  const scoped = scopedKeys ? new Set(scopedKeys) : null;
  const agentAccess = ownValue(routing.agentAccess, agentType);

  if (parentModelKey && modelKey === parentModelKey) {
    return agentAccess?.parentModelAccess === false
      ? { ok: false, reason: "parent-model-denied" }
      : { ok: true };
  }
  if (!routing.enabled) return { ok: false, reason: "routing-disabled" };

  const slash = modelKey.indexOf("/");
  if (slash <= 0) return { ok: false, reason: "model-unavailable" };
  const provider = modelKey.slice(0, slash);
  const modelId = modelKey.slice(slash + 1);

  if (!routing.enabledProviders.includes(provider)) {
    return { ok: false, reason: "provider-disabled" };
  }
  const access = agentAccess ? ownValue(agentAccess.providers, provider) : undefined;
  if (!access) return { ok: false, reason: "agent-provider-denied" };
  if (access.models && !access.models.includes(modelId)) {
    return { ok: false, reason: "model-denied" };
  }
  if (!available.has(modelKey)) return { ok: false, reason: "model-unavailable" };
  if (scoped && !scoped.has(modelKey)) return { ok: false, reason: "out-of-scope" };
  return { ok: true };
}
