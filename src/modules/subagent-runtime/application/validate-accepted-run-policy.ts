import { Check } from "typebox/value";
import {
  AcceptedRunPolicySchema,
  type AcceptedRunPolicy,
} from "../contracts/accepted-run-policy.js";

function isPlainJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  if (keys.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const isArrayLength = Array.isArray(value) && key === "length";
    return descriptor?.get !== undefined
      || descriptor?.set !== undefined
      || (descriptor?.enumerable === false && !isArrayLength);
  })) return false;

  ancestors.add(value);
  const valid = keys.every((key) => isPlainJsonValue(Reflect.get(value, key), ancestors));
  ancestors.delete(value);
  return valid;
}

function hasConsistentDerivedValues(candidate: AcceptedRunPolicy): boolean {
  const parentModelKey = candidate.parentModel
    ? `${candidate.parentModel.provider}/${candidate.parentModel.id}`
    : "";
  if (candidate.parentModelKey !== parentModelKey) return false;

  const configuredTurnLimit = candidate.definition.maxTurns;
  const expectedTurnLimit = configuredTurnLimit == null || configuredTurnLimit === 0
    ? null
    : Math.max(1, configuredTurnLimit);
  return candidate.outputTokenLimit === candidate.model.maxTokens
    && candidate.turnLimit === expectedTurnLimit;
}

export function parseAcceptedRunPolicy(value: unknown): AcceptedRunPolicy | undefined {
  try {
    if (!isPlainJsonValue(value) || !Check(AcceptedRunPolicySchema, value)) return undefined;
    const candidate = value as AcceptedRunPolicy;
    if (!hasConsistentDerivedValues(candidate)) return undefined;
    const snapshot: unknown = JSON.parse(JSON.stringify(value));
    return Check(AcceptedRunPolicySchema, snapshot)
      && hasConsistentDerivedValues(snapshot as AcceptedRunPolicy)
      ? snapshot as AcceptedRunPolicy
      : undefined;
  } catch {
    return undefined;
  }
}
