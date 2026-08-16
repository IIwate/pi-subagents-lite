import { Type, type Static } from "typebox";
import { JsonValueSchema } from "../../configuration/public.js";

export const ConcurrencyLimitsSchema = Type.Object({
  defaultModelLimit: Type.Integer({ minimum: 1 }),
  modelLimits: Type.Record(Type.String(), Type.Integer({ minimum: 1 })),
  providerLimits: Type.Record(Type.String(), Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

/**
 * Persisted `concurrency` section in its physical JSON field names. The
 * runtime owns this fragment: parsing tolerates hand-edited junk, updates go
 * through `ConcurrencyLimitsUpdate`, and the effective scheduler shape is
 * derived with `runtimeLimitsFromFragment`.
 */
export const ConcurrencyLimitsFragmentSchema = Type.Object({
  default: Type.Integer({ minimum: 1 }),
  providers: Type.Record(Type.String(), Type.Integer({ minimum: 1 })),
  models: Type.Record(Type.String(), Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

export const ConcurrencyLimitsUpdateSchema = Type.Union([
  Type.Object({
    scope: Type.Literal("default"),
    // null removes the explicit default: the project layer falls back to
    // inheritance, the global layer to the factory default.
    limit: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  }, { additionalProperties: false }),
  Type.Object({
    scope: Type.Union([Type.Literal("provider"), Type.Literal("model")]),
    key: Type.String({ minLength: 1 }),
    // null removes the override; the fallback limit takes over again.
    limit: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  }, { additionalProperties: false }),
  Type.Object({
    scope: Type.Literal("reset"),
  }, { additionalProperties: false }),
]);

export const ConcurrencyDecisionSchema = Type.Union([
  Type.Object({
    accepted: Type.Literal(true),
    concurrencyKey: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    accepted: Type.Literal(false),
    reason: Type.Literal("concurrency"),
    concurrencyKey: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
]);

export type ConcurrencyLimits = Static<typeof ConcurrencyLimitsSchema>;
export type ConcurrencyDecision = Static<typeof ConcurrencyDecisionSchema>;
export type ConcurrencyLimitsFragment = Static<typeof ConcurrencyLimitsFragmentSchema>;
export type ConcurrencyLimitsUpdate = Static<typeof ConcurrencyLimitsUpdateSchema>;

/**
 * Layered concurrency (REQ-RUNTIME-008). A layer fragment is sparse: every
 * key may be absent, meaning "inherit" (project) or "factory default"
 * (global). Presence records only keys that physically exist and parsed
 * valid, so provenance never has to guess from a normalized fragment.
 */
export const ConcurrencyLayerFragmentSchema = Type.Object({
  default: Type.Optional(Type.Integer({ minimum: 1 })),
  providers: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 1 }))),
  models: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 1 }))),
}, { additionalProperties: false });

/** Persisted project `concurrency` section; physical field names unchanged. */
export const ConcurrencyProjectFragmentSchema = ConcurrencyLayerFragmentSchema;

export const ConcurrencyLayerPresenceSchema = Type.Object({
  default: Type.Boolean(),
  providers: Type.Record(Type.String(), Type.Boolean()),
  models: Type.Record(Type.String(), Type.Boolean()),
}, { additionalProperties: false });

export const ConcurrencyLayerParseResultSchema = Type.Object({
  fragment: ConcurrencyLayerFragmentSchema,
  presence: ConcurrencyLayerPresenceSchema,
  ignoredEntryCount: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export const ConcurrencyValueSourceSchema = Type.Union([
  Type.Literal("default"),
  Type.Literal("global"),
  Type.Literal("project"),
]);

const ConcurrencyOverrideSourceSchema = Type.Union([
  Type.Literal("global"),
  Type.Literal("project"),
]);

export const ConcurrencyProvenanceSchema = Type.Object({
  default: ConcurrencyValueSourceSchema,
  providers: Type.Record(Type.String(), ConcurrencyOverrideSourceSchema),
  models: Type.Record(Type.String(), ConcurrencyOverrideSourceSchema),
}, { additionalProperties: false });

export const MergedConcurrencyLimitsSchema = Type.Object({
  effective: ConcurrencyLimitsFragmentSchema,
  provenance: ConcurrencyProvenanceSchema,
}, { additionalProperties: false });

export const ConcurrencyTargetSchema = Type.Union([
  Type.Literal("global"),
  Type.Literal("project"),
]);

/**
 * Minimal write set for one layer update, computed from the raw persisted
 * section so unrecognized JSON entries ride along instead of being cleaned.
 */
export const ConcurrencyLayerUpdatePlanSchema = Type.Object({
  assignments: Type.Record(Type.String(), JsonValueSchema),
  removals: Type.Array(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

export type ConcurrencyLayerFragment = Static<typeof ConcurrencyLayerFragmentSchema>;
export type ConcurrencyProjectFragment = Static<typeof ConcurrencyProjectFragmentSchema>;
export type ConcurrencyLayerPresence = Static<typeof ConcurrencyLayerPresenceSchema>;
export type ConcurrencyLayerParseResult = Static<typeof ConcurrencyLayerParseResultSchema>;
export type ConcurrencyValueSource = Static<typeof ConcurrencyValueSourceSchema>;
export type ConcurrencyProvenance = Static<typeof ConcurrencyProvenanceSchema>;
export type MergedConcurrencyLimits = Static<typeof MergedConcurrencyLimitsSchema>;
export type ConcurrencyTarget = Static<typeof ConcurrencyTargetSchema>;
export type ConcurrencyLayerUpdatePlan = Static<typeof ConcurrencyLayerUpdatePlanSchema>;
