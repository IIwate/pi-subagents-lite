import { Type, type Static } from "typebox";

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
    limit: Type.Integer({ minimum: 1 }),
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
