import type { ThinkingAccessOverride, ThinkingLevel } from "../contracts/model-access-contracts.js";

const CANONICAL_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export interface ThinkingAccessPolicy {
  allowed: ThinkingLevel[];
  default: ThinkingLevel;
  source: "scope" | "override" | "baseline";
}

export type ThinkingSelection =
  | { ok: true; level: ThinkingLevel }
  | { ok: false; reason: "thinking-denied"; allowed: ThinkingLevel[] };

function canonicalLevel(value: string | undefined): ThinkingLevel | undefined {
  return value && CANONICAL_LEVELS.has(value as ThinkingLevel) ? value as ThinkingLevel : undefined;
}

export function decideThinkingAccess(input: {
  modelKey: string;
  parentModelKey: string;
  parentThinkingLevel: string | undefined;
  scopedThinkingLevel: string | undefined;
  supportedLevels: readonly ThinkingLevel[];
  fallbackLevel: ThinkingLevel;
  override: ThinkingAccessOverride | undefined;
}): ThinkingAccessPolicy | null {
  const scopeLevel = canonicalLevel(input.scopedThinkingLevel);
  if (scopeLevel) {
    return { allowed: [scopeLevel], default: scopeLevel, source: "scope" };
  }

  const supportedSet = new Set<ThinkingLevel>(input.supportedLevels);
  if (input.override) {
    const allowed = input.override.allowed.filter((level) => supportedSet.has(level));
    if (allowed.length === 0 || !supportedSet.has(input.override.default) || !allowed.includes(input.override.default)) {
      return null;
    }
    return { allowed: [...allowed], default: input.override.default, source: "override" };
  }

  const parentDefault = canonicalLevel(input.parentThinkingLevel);
  const defaultLevel = input.modelKey === input.parentModelKey && parentDefault && supportedSet.has(parentDefault)
    ? parentDefault
    : input.fallbackLevel;
  return { allowed: [...input.supportedLevels], default: defaultLevel, source: "baseline" };
}

export function decideThinkingSelection(
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
