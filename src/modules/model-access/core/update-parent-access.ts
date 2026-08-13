import type { AgentModelAccess, ModelAccessFragment } from "../contracts/model-access-contracts.js";

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
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

export function applyParentModelAccess(
  routing: ModelAccessFragment,
  agentType: string,
  allowed: boolean,
): ModelAccessFragment {
  const next: ModelAccessFragment = structuredClone(routing);
  const existing = ownValue(next.agentAccess, agentType);
  if (allowed) {
    if (!existing || existing.parentModelAccess === undefined) return next;
    delete existing.parentModelAccess;
    pruneAgentAccess(next.agentAccess, agentType);
    return next;
  }
  const access = existing ?? { providers: {} };
  if (!existing) {
    Object.defineProperty(next.agentAccess, agentType, {
      value: access,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  access.parentModelAccess = false;
  return next;
}
