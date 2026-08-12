import { Type, type Static } from "typebox";
import { AgentDefinitionSnapshotSchema } from "../../agent-catalogue/public.js";

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
}, { additionalProperties: false });

export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;
export type SystemPromptMode = Static<typeof SystemPromptModeSchema>;
export type AgentInvocation = Static<typeof AgentInvocationSchema>;
export type AcceptedRunPolicy = Static<typeof AcceptedRunPolicySchema>;
