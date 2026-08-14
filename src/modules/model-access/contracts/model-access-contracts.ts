import { Type, type Static } from "typebox";

/**
 * The Thinking vocabulary, and the only definition of it. Written as explicit
 * literals rather than mapped from an array because `Type.Unsafe` around a
 * mapped union erases the static shape, and every union that embeds this schema
 * then loses discriminated-narrowing at its own boundary.
 */
export const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

/** Ascending order, derived from the schema so a new level cannot be missed. */
export const CANONICAL_THINKING_LEVELS = ThinkingLevelSchema.anyOf.map(
  (member) => member.const,
) as readonly Static<typeof ThinkingLevelSchema>[];

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

/**
 * The resolved Thinking envelope for one agent/model pair. Schema-defined
 * because the prompt module renders it into guidance text: it leaves this
 * module, so its shape is a contract rather than an internal convenience.
 */
export const ThinkingAccessPolicySchema = Type.Object({
  allowed: Type.Array(ThinkingLevelSchema, { minItems: 1 }),
  default: ThinkingLevelSchema,
  source: Type.Union([
    Type.Literal("scope"),
    Type.Literal("override"),
    Type.Literal("baseline"),
  ]),
}, { additionalProperties: false });

export const ThinkingSelectionSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    level: ThinkingLevelSchema,
  }, { additionalProperties: false }),
  Type.Object({
    ok: Type.Literal(false),
    reason: Type.Literal("thinking-denied"),
    allowed: Type.Array(ThinkingLevelSchema),
  }, { additionalProperties: false }),
]);

export const ResolveThinkingAccessQuerySchema = Type.Object({
  routing: Type.Unknown(),
  agentType: Type.String({ minLength: 1 }),
  modelKey: Type.String({ minLength: 1 }),
  parentModelKey: Type.String(),
  parentThinkingLevel: Type.Optional(Type.String()),
  scopedThinkingLevel: Type.Optional(Type.String()),
  supportedLevels: Type.Array(ThinkingLevelSchema),
  fallbackLevel: ThinkingLevelSchema,
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
export type ThinkingAccessPolicy = Static<typeof ThinkingAccessPolicySchema>;
export type ThinkingSelection = Static<typeof ThinkingSelectionSchema>;
export type ResolveThinkingAccessQuery = Static<typeof ResolveThinkingAccessQuerySchema>;
export type AuthorizationDenialReason = Static<typeof AuthorizationDenialReasonSchema>;
export type AuthorizeModelCommand = Static<typeof AuthorizeModelCommandSchema>;
export type AuthorizeModelResult = Static<typeof AuthorizeModelResultSchema>;
