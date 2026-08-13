import { Type, type Static } from "typebox";

export const ConcurrencyLimitsSchema = Type.Object({
  defaultModelLimit: Type.Integer({ minimum: 1 }),
  modelLimits: Type.Record(Type.String(), Type.Integer({ minimum: 1 })),
  providerLimits: Type.Record(Type.String(), Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

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
