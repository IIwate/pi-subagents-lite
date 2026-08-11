import type { Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { AgentModelAccess } from "../config/types.js";
import { CANONICAL_THINKING_LEVELS } from "../config/types.js";
import type { ThinkingLevel } from "../types.js";

export interface ThinkingAccessPolicy {
  allowed: ThinkingLevel[];
  default: ThinkingLevel;
  source: "scope" | "override" | "baseline";
}

export interface ResolveThinkingAccessOptions {
  agentAccess: Readonly<AgentModelAccess> | undefined;
  model: Model<any>;
  modelKey: string;
  parentModelKey: string;
  parentThinkingLevel: ThinkingLevel | undefined;
  scopedThinkingLevel: string | undefined;
}

const CANONICAL_LEVELS = new Set<string>(CANONICAL_THINKING_LEVELS);

function canonicalLevel(value: string | undefined): ThinkingLevel | undefined {
  return value && CANONICAL_LEVELS.has(value) ? value as ThinkingLevel : undefined;
}

export function resolveThinkingAccess(
  options: ResolveThinkingAccessOptions,
): ThinkingAccessPolicy | null {
  const scopeLevel = canonicalLevel(options.scopedThinkingLevel);
  if (scopeLevel) {
    return { allowed: [scopeLevel], default: scopeLevel, source: "scope" };
  }

  const supported = getSupportedThinkingLevels(options.model) as ThinkingLevel[];
  const supportedSet = new Set<ThinkingLevel>(supported);
  const override = options.agentAccess?.thinking?.[options.modelKey];
  if (override) {
    const allowed = override.allowed.filter((level) => supportedSet.has(level));
    if (allowed.length === 0 || !supportedSet.has(override.default) || !allowed.includes(override.default)) {
      return null;
    }
    return { allowed: [...allowed], default: override.default, source: "override" };
  }

  const fallback = clampThinkingLevel(options.model, "high") as ThinkingLevel;
  const parentDefault = canonicalLevel(options.parentThinkingLevel);
  const defaultLevel = options.modelKey === options.parentModelKey && parentDefault && supportedSet.has(parentDefault)
    ? parentDefault
    : fallback;
  return { allowed: [...supported], default: defaultLevel, source: "baseline" };
}

export type ThinkingSelection =
  | { ok: true; level: ThinkingLevel }
  | { ok: false; reason: "thinking-denied"; allowed: ThinkingLevel[] };

export function selectThinkingLevel(
  policy: Readonly<ThinkingAccessPolicy>,
  requested: string | undefined,
): ThinkingSelection {
  if (requested === undefined) return { ok: true, level: policy.default };
  const level = canonicalLevel(requested);
  if (!level || !policy.allowed.includes(level)) {
    return { ok: false, reason: "thinking-denied", allowed: [...policy.allowed] };
  }
  return { ok: true, level };
}
