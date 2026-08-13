import { Type, type Static } from "typebox";

/** Canonical Pi thinking levels; the schema below is derived from this list. */
export const CANONICAL_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

// Type.Union cannot infer a literal union from a mapped array, so the static
// type is pinned to the canonical list the schema is built from.
export const ThinkingLevelSchema = Type.Unsafe<(typeof CANONICAL_THINKING_LEVELS)[number]>(
  Type.Union(CANONICAL_THINKING_LEVELS.map((level) => Type.Literal(level))),
);

export const ProviderModelAccessSchema = Type.Object({
  models: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
}, { additionalProperties: false });

export const ThinkingAccessOverrideSchema = Type.Object({
  allowed: Type.Array(ThinkingLevelSchema, { minItems: 1 }),
  default: ThinkingLevelSchema,
}, { additionalProperties: false });

export const AgentModelAccessSchema = Type.Object({
  parentModelAccess: Type.Optional(Type.Boolean()),
  providers: Type.Record(Type.String(), ProviderModelAccessSchema),
  thinking: Type.Optional(Type.Record(Type.String(), ThinkingAccessOverrideSchema)),
}, { additionalProperties: false });

export const ModelAccessFragmentSchema = Type.Object({
  enabled: Type.Boolean(),
  enabledProviders: Type.Array(Type.String({ minLength: 1 })),
  agentAccess: Type.Record(Type.String(), AgentModelAccessSchema),
}, { additionalProperties: false });

export const AuthorizationDenialReasonSchema = Type.Union([
  Type.Literal("parent-model-denied"),
  Type.Literal("routing-disabled"),
  Type.Literal("provider-disabled"),
  Type.Literal("agent-provider-denied"),
  Type.Literal("model-denied"),
  Type.Literal("model-unavailable"),
  Type.Literal("out-of-scope"),
]);

export const AuthorizeModelCommandSchema = Type.Object({
  kind: Type.Literal("authorize"),
  agentType: Type.String({ minLength: 1 }),
  modelKey: Type.String({ minLength: 1 }),
  parentModelKey: Type.String(),
  routing: ModelAccessFragmentSchema,
  availableKeys: Type.Array(Type.String()),
  scopedKeys: Type.Union([Type.Array(Type.String()), Type.Null()]),
}, { additionalProperties: false });

export const AuthorizeModelResultSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
  }, { additionalProperties: false }),
  Type.Object({
    ok: Type.Literal(false),
    reason: AuthorizationDenialReasonSchema,
  }, { additionalProperties: false }),
  Type.Object({
    ok: Type.Literal(false),
    error: Type.Object({
      code: Type.Literal("invalid-command"),
      message: Type.String(),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
]);

export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;
export type ProviderModelAccess = Static<typeof ProviderModelAccessSchema>;
export type ThinkingAccessOverride = Static<typeof ThinkingAccessOverrideSchema>;
export type AgentModelAccess = Static<typeof AgentModelAccessSchema>;
export type ModelAccessFragment = Static<typeof ModelAccessFragmentSchema>;
export type AuthorizationDenialReason = Static<typeof AuthorizationDenialReasonSchema>;
export type AuthorizeModelCommand = Static<typeof AuthorizeModelCommandSchema>;
export type AuthorizeModelResult = Static<typeof AuthorizeModelResultSchema>;
