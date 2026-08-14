import {
  AcceptedModelSnapshotSchema,
  AcceptedScopedModelSchema,
} from "../modules/subagent-runtime/public.js";

function objectKeys(schema: { properties?: Record<string, unknown> }): string[] {
  return Object.keys(schema.properties ?? {});
}

const ACCEPTED_MODEL_FIELD_KEYS = objectKeys(AcceptedModelSnapshotSchema);
const ACCEPTED_SCOPED_FIELD_KEYS = objectKeys(AcceptedScopedModelSchema);

function projectPiModelSnapshot(value: unknown): unknown {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of ACCEPTED_MODEL_FIELD_KEYS) {
    const field = source[key];
    if (field !== undefined) projected[key] = field;
  }
  return projected;
}

function projectPiScopedModels(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const source = entry as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const key of ACCEPTED_SCOPED_FIELD_KEYS) {
      const field = key === "model" ? projectPiModelSnapshot(source.model) : source[key];
      if (field !== undefined) projected[key] = field;
    }
    return projected;
  });
}

/**
 * Pi 0.84.1 writes undefined own keys after models.json composition and
 * hangs `source` on the same object the child session will never read.
 * Check is fail-closed; those leftovers are not a contract. This is the
 * only place that knows the vendor snapshot. Parse stays a Check.
 * Revisit when Pi stops writing undefined keys and host-only tags on Model.
 */
export function projectPiAcceptedRunPolicyInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  return {
    ...source,
    model: projectPiModelSnapshot(source.model),
    parentModel: projectPiModelSnapshot(source.parentModel),
    scopedModels: projectPiScopedModels(source.scopedModels),
  };
}
