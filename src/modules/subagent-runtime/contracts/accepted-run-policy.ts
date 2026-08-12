import { Type, type Static } from "typebox";
import { AgentDefinitionSnapshotSchema } from "../../agent-catalogue/public.js";

const JsonValueSchema = Type.Cyclic({
  JsonValue: Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String(),
    Type.Array(Type.Ref("JsonValue")),
    Type.Record(Type.String(), Type.Ref("JsonValue")),
  ]),
}, "JsonValue");

export const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

export const SystemPromptModeSchema = Type.Union([
  Type.Literal("replace"),
  Type.Literal("inherit"),
  Type.Literal("custom"),
]);

export const AgentInvocationSchema = Type.Object({
  modelName: Type.Optional(Type.String()),
  providerName: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
}, { additionalProperties: false });

const ModelCostRatesSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
}, { additionalProperties: false });

const ModelCostSchema = Type.Object({
  ...ModelCostRatesSchema.properties,
  tiers: Type.Optional(Type.Array(Type.Object({
    ...ModelCostRatesSchema.properties,
    inputTokensAbove: Type.Number(),
  }, { additionalProperties: false }))),
}, { additionalProperties: false });

export const AcceptedModelSnapshotSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  api: Type.String({ minLength: 1 }),
  provider: Type.String({ minLength: 1 }),
  baseUrl: Type.String(),
  reasoning: Type.Boolean(),
  thinkingLevelMap: Type.Optional(Type.Record(
    Type.String(),
    Type.Union([Type.String(), Type.Null()]),
  )),
  input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
  cost: ModelCostSchema,
  contextWindow: Type.Number(),
  maxTokens: Type.Number(),
  samplingParams: Type.Optional(Type.Record(Type.String(), JsonValueSchema)),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  compat: Type.Optional(JsonValueSchema),
}, { additionalProperties: false });

export const AcceptedScopedModelSchema = Type.Object({
  model: AcceptedModelSnapshotSchema,
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
}, { additionalProperties: false });

export const AcceptedRunPolicySchema = Type.Object({
  definition: AgentDefinitionSnapshotSchema,
  registeredTools: Type.Array(Type.String()),
  restrictToRegisteredTools: Type.Boolean(),
  tools: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())])),
  extensions: Type.Union([Type.Boolean(), Type.Array(Type.String())]),
  skills: Type.Union([Type.Boolean(), Type.Array(Type.String())]),
  systemPromptMode: SystemPromptModeSchema,
  includeContextFiles: Type.Boolean(),
  parentModelKey: Type.String(),
  model: AcceptedModelSnapshotSchema,
  parentModel: Type.Union([AcceptedModelSnapshotSchema, Type.Null()]),
  scopedModels: Type.Array(AcceptedScopedModelSchema),
  thinkingLevel: Type.Union([ThinkingLevelSchema, Type.Null()]),
  outputTokenLimit: Type.Number({ exclusiveMinimum: 0 }),
  turnLimit: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  graceTurns: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export type AcceptedModelSnapshot = Static<typeof AcceptedModelSnapshotSchema>;
export type AcceptedScopedModel = Static<typeof AcceptedScopedModelSchema>;
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;
export type SystemPromptMode = Static<typeof SystemPromptModeSchema>;
export type AgentInvocation = Static<typeof AgentInvocationSchema>;
export type AcceptedRunPolicy = Static<typeof AcceptedRunPolicySchema>;
