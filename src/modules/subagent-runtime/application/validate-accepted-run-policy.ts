import { Check, Errors } from "typebox/value";
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

function jsonPath(parent: string, key: string, isArray: boolean): string {
  if (isArray) return parent ? `${parent}[${key}]` : `[${key}]`;
  return parent ? `${parent}.${key}` : key;
}

function firstNonPlainPath(value: unknown, path = "", ancestors = new Set<object>()): string | undefined {
  if (value === undefined) return path || "/";
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : path || "/";
  if (typeof value !== "object" || ancestors.has(value)) return path || "/";

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    return path || "/";
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return path || "/";
  if (keys.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const isArrayLength = Array.isArray(value) && key === "length";
    return descriptor?.get !== undefined
      || descriptor?.set !== undefined
      || (descriptor?.enumerable === false && !isArrayLength);
  })) return path || "/";

  ancestors.add(value);
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const childPath = firstNonPlainPath(
      Reflect.get(value, key),
      jsonPath(path, key, Array.isArray(value)),
      ancestors,
    );
    if (childPath) {
      ancestors.delete(value);
      return childPath;
    }
  }
  ancestors.delete(value);
  return undefined;
}

function describeCheckFailure(value: unknown): string {
  const errors = Errors(AcceptedRunPolicySchema, value);
  if (errors.length === 0) return "accepted run policy failed schema validation.";
  return errors.slice(0, 3).map((error) => {
    const path = error.instancePath || "/";
    if (error.keyword === "additionalProperties") {
      const extras = (error.params as { additionalProperties?: string[] }).additionalProperties ?? [];
      return extras.length > 0
        ? `${path} has additional properties: ${extras.join(", ")}.`
        : `${path} must not have additional properties.`;
    }
    const message = error.message.endsWith(".") ? error.message : `${error.message}.`;
    return `${path} ${message}`;
  }).join(" ");
}

function describeDerivedFailure(candidate: AcceptedRunPolicy): string {
  const parentModelKey = candidate.parentModel
    ? `${candidate.parentModel.provider}/${candidate.parentModel.id}`
    : "";
  if (candidate.parentModelKey !== parentModelKey) {
    return `parentModelKey ${JSON.stringify(candidate.parentModelKey)} does not match ${JSON.stringify(parentModelKey)}.`;
  }
  if (candidate.outputTokenLimit !== candidate.model.maxTokens) {
    return `outputTokenLimit ${candidate.outputTokenLimit} does not match model.maxTokens ${candidate.model.maxTokens}.`;
  }
  return "turnLimit does not match definition.maxTurns.";
}

/**
 * Same gate as parse: the value must already be a contract object. Vendor
 * leftovers are not dropped here; the caller that assembled a Pi snapshot
 * projects first. Revisit if a second inbound language appears.
 */
function acceptedRunPolicySnapshot(value: unknown): AcceptedRunPolicy | undefined {
  if (!isPlainJsonValue(value) || !Check(AcceptedRunPolicySchema, value)) return undefined;
  const candidate = value as AcceptedRunPolicy;
  if (!hasConsistentDerivedValues(candidate)) return undefined;
  const snapshot: unknown = JSON.parse(JSON.stringify(value));
  return Check(AcceptedRunPolicySchema, snapshot)
    && hasConsistentDerivedValues(snapshot as AcceptedRunPolicy)
    ? snapshot as AcceptedRunPolicy
    : undefined;
}

export function describeAcceptedRunPolicyFailure(value: unknown): string {
  try {
    if (!isPlainJsonValue(value)) {
      const path = firstNonPlainPath(value);
      return path
        ? `${path} is not a plain JSON value.`
        : "accepted run policy is not a plain JSON value.";
    }
    if (!Check(AcceptedRunPolicySchema, value)) return describeCheckFailure(value);
    const candidate = value as AcceptedRunPolicy;
    if (!hasConsistentDerivedValues(candidate)) return describeDerivedFailure(candidate);
    if (!acceptedRunPolicySnapshot(value)) {
      return "accepted run policy failed JSON snapshot validation.";
    }
    return "accepted run policy is invalid.";
  } catch {
    return "accepted run policy could not be read.";
  }
}

export function parseAcceptedRunPolicy(value: unknown): AcceptedRunPolicy | undefined {
  try {
    return acceptedRunPolicySnapshot(value);
  } catch {
    return undefined;
  }
}
