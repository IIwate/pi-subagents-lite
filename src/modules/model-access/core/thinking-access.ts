import { CANONICAL_THINKING_LEVELS } from "../contracts/model-access-contracts.js";
import type {
  ThinkingAccessOverride,
  ThinkingAccessPolicy,
  ThinkingLevel,
  ThinkingSelection,
} from "../contracts/model-access-contracts.js";

function canonicalLevel(value: string | undefined): ThinkingLevel | undefined {
  return CANONICAL_THINKING_LEVELS.find((level) => level === value);
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

  // Host catalogues have been wrong before. Copying supportedLevels as-is is
  // how a vendor nickname becomes a policy the rest of the product cannot
  // name. Levels outside the vocabulary are dropped; an empty remainder is
  // no policy at all. Revisit if Pi grows a stable thinking enum we can trust.
  const allowed = CANONICAL_THINKING_LEVELS.filter((level) => input.supportedLevels.includes(level));
  const supportedSet = new Set<ThinkingLevel>(allowed);
  if (allowed.length === 0) return null;
  if (input.override) {
    const overrideAllowed = input.override.allowed.filter((level) => supportedSet.has(level));
    if (overrideAllowed.length === 0 || !supportedSet.has(input.override.default) || !overrideAllowed.includes(input.override.default)) {
      return null;
    }
    return { allowed: [...overrideAllowed], default: input.override.default, source: "override" };
  }

  const parentDefault = canonicalLevel(input.parentThinkingLevel);
  const defaultLevel = input.modelKey === input.parentModelKey && parentDefault && supportedSet.has(parentDefault)
    ? parentDefault
    : input.fallbackLevel;
  if (!supportedSet.has(defaultLevel)) return null;
  return { allowed: [...allowed], default: defaultLevel, source: "baseline" };
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

export type { ThinkingAccessPolicy, ThinkingSelection };
