import { Check, Errors } from "typebox/value";
import {
  AcceptedRunPolicySchema,
  type AcceptedRunPolicy,
} from "../contracts/accepted-run-policy.js";

const ACCEPTED_MODEL_KEYS = [
  "id",
  "name",
  "api",
  "provider",
  "baseUrl",
  "reasoning",
  "thinkingLevelMap",
  "input",
  "cost",
  "contextWindow",
  "maxTokens",
  "samplingParams",
  "headers",
  "compat",
] as const;

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

/**
 * Pi never hands us a contract object. After models.json composition it writes
 * `headers: undefined` so the key still exists; after `/scoped-models` it
 * pushes `{ model, thinkingLevel }` even when nobody chose a level. Host
 * extensions then hang private tags on the same object. Check would forgive
 * the undefined and then `additionalProperties: false` would hang the whole
 * spawn on a field the child session will never read. We keep the serializable
 * Model fields and drop the rest. This still dies when a required field is
 * missing or the wrong type. Revisit if Pi stops writing undefined own keys
 * and stops attaching host-only properties to Model.
 */
function projectAcceptedModel(value: unknown): unknown {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of ACCEPTED_MODEL_KEYS) {
    const field = source[key];
    if (field !== undefined) projected[key] = field;
  }
  return projected;
}

function projectScopedModels(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const source = entry as Record<string, unknown>;
    const projected: Record<string, unknown> = {
      model: projectAcceptedModel(source.model),
    };
    if (source.thinkingLevel !== undefined) projected.thinkingLevel = source.thinkingLevel;
    return projected;
  });
}

function projectAcceptedRunPolicyInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  return {
    ...source,
    model: projectAcceptedModel(source.model),
    parentModel: projectAcceptedModel(source.parentModel),
    scopedModels: projectScopedModels(source.scopedModels),
  };
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

export function describeAcceptedRunPolicyFailure(value: unknown): string {
  try {
    const projected = projectAcceptedRunPolicyInput(value);
    if (!isPlainJsonValue(projected)) {
      const path = firstNonPlainPath(projected);
      return path
        ? `${path} is not a plain JSON value.`
        : "accepted run policy is not a plain JSON value.";
    }
    if (!Check(AcceptedRunPolicySchema, projected)) return describeCheckFailure(projected);
    const candidate = projected as AcceptedRunPolicy;
    if (!hasConsistentDerivedValues(candidate)) return describeDerivedFailure(candidate);
    const snapshot: unknown = JSON.parse(JSON.stringify(projected));
    if (
      !Check(AcceptedRunPolicySchema, snapshot)
      || !hasConsistentDerivedValues(snapshot as AcceptedRunPolicy)
    ) {
      return "accepted run policy failed JSON snapshot validation.";
    }
    return "accepted run policy is invalid.";
  } catch {
    return "accepted run policy could not be read.";
  }
}

export function parseAcceptedRunPolicy(value: unknown): AcceptedRunPolicy | undefined {
  try {
    const projected = projectAcceptedRunPolicyInput(value);
    if (!isPlainJsonValue(projected) || !Check(AcceptedRunPolicySchema, projected)) return undefined;
    const candidate = projected as AcceptedRunPolicy;
    if (!hasConsistentDerivedValues(candidate)) return undefined;
    const snapshot: unknown = JSON.parse(JSON.stringify(projected));
    return Check(AcceptedRunPolicySchema, snapshot)
      && hasConsistentDerivedValues(snapshot as AcceptedRunPolicy)
      ? snapshot as AcceptedRunPolicy
      : undefined;
  } catch {
    return undefined;
  }
}
