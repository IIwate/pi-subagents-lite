import { Type, type Static } from "typebox";
import {
  ModelAccessFragmentSchema,
  ThinkingLevelSchema,
} from "../../model-access/public.js";

const GuidanceAgentSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.String(),
  registeredTools: Type.Optional(Type.Array(Type.String())),
  maxTurns: Type.Optional(Type.Number()),
}, { additionalProperties: false });

const AvailableGuidanceModelSchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  supportedLevels: Type.Array(ThinkingLevelSchema),
  fallbackLevel: ThinkingLevelSchema,
  scopedThinkingLevel: Type.Union([ThinkingLevelSchema, Type.Null()]),
}, { additionalProperties: false });

export const AgentGuidanceRequestSchema = Type.Object({
  kind: Type.Literal("assemble-guidance"),
  agents: Type.Array(GuidanceAgentSchema),
  parentModelKey: Type.String(),
  parentThinkingLevel: Type.Union([ThinkingLevelSchema, Type.Null()]),
  parentSupportedLevels: Type.Array(ThinkingLevelSchema),
  parentFallbackLevel: ThinkingLevelSchema,
  parentScopedThinkingLevel: Type.Union([ThinkingLevelSchema, Type.Null()]),
  routing: ModelAccessFragmentSchema,
  availableModels: Type.Array(AvailableGuidanceModelSchema),
  scopedKeys: Type.Union([Type.Array(Type.String()), Type.Null()]),
}, { additionalProperties: false });

export const AgentGuidanceResultSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    guidance: Type.String(),
  }, { additionalProperties: false }),
  Type.Object({
    ok: Type.Literal(false),
    error: Type.Object({
      code: Type.Literal("invalid-command"),
      message: Type.String(),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
]);

export const SubagentPromptEnvSchema = Type.Object({
  isGitRepo: Type.Boolean(),
  branch: Type.Union([Type.String(), Type.Null()]),
  platform: Type.String(),
}, { additionalProperties: false });

export const SubagentPromptRequestSchema = Type.Object({
  kind: Type.Literal("assemble-subagent-prompt"),
  mode: Type.Union([Type.Literal("replace"), Type.Literal("inherit"), Type.Literal("custom")]),
  agentName: Type.String({ minLength: 1 }),
  agentInstructions: Type.String(),
  cwd: Type.String(),
  env: SubagentPromptEnvSchema,
  header: Type.Union([Type.String(), Type.Null()]),
  contextFiles: Type.Array(Type.Object({
    path: Type.String(),
    content: Type.String(),
  }, { additionalProperties: false })),
  skillElements: Type.Array(Type.String()),
}, { additionalProperties: false });

export const SubagentPromptResultSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    prompt: Type.String(),
  }, { additionalProperties: false }),
  Type.Object({
    ok: Type.Literal(false),
    error: Type.Object({
      code: Type.Literal("invalid-command"),
      message: Type.String(),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
]);

export type AgentGuidanceRequest = Static<typeof AgentGuidanceRequestSchema>;
export type AgentGuidanceResult = Static<typeof AgentGuidanceResultSchema>;
export type SubagentPromptRequest = Static<typeof SubagentPromptRequestSchema>;
export type SubagentPromptResult = Static<typeof SubagentPromptResultSchema>;
