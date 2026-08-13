import { Type, type Static } from "typebox";
import { AcceptedRunPolicySchema, ThinkingLevelSchema } from "./accepted-run-policy.js";
import { DebugFaultKindSchema, LifetimeUsageSchema } from "./lifecycle.js";

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

export const SessionStartRequestSchema = Type.Object({
  agentId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  agentType: Type.String({ minLength: 1 }),
  prompt: Type.String(),
  acceptedPolicy: AcceptedRunPolicySchema,
  worktreePath: Type.Optional(Type.String()),
  debugFault: Type.Optional(DebugFaultKindSchema),
}, { additionalProperties: false });

export const SessionContinueRequestSchema = Type.Object({
  agentId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  prompt: Type.String(),
  images: Type.Optional(Type.Array(JsonValueSchema)),
  maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
  graceTurns: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });

export const SessionSteerRequestSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  message: Type.String(),
  images: Type.Optional(Type.Array(JsonValueSchema)),
}, { additionalProperties: false });

export const SessionAbortRequestSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const SessionCloseRequestSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const SessionInspectRequestSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const SessionSteerResultSchema = Type.Object({
  accepted: Type.Boolean(),
}, { additionalProperties: false });

export const SessionInspectResultSchema = Type.Object({
  found: Type.Boolean(),
  live: Type.Boolean(),
  streaming: Type.Boolean(),
  modelId: Type.Optional(Type.String()),
  provider: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  contextPercent: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  messages: Type.Array(JsonValueSchema),
  streamingMessage: Type.Optional(JsonValueSchema),
}, { additionalProperties: false });

export const SessionEventSchema = Type.Union([
  Type.Object({
    type: Type.Literal("setup-started"),
    agentId: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("setup-finished"),
    agentId: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("session-ready"),
    agentId: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    modelId: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    thinkingLevel: Type.Optional(ThinkingLevelSchema),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("progress"),
    agentId: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    toolUse: Type.Optional(Type.Boolean()),
    usage: Type.Optional(LifetimeUsageSchema),
    compaction: Type.Optional(Type.Boolean()),
    turnCount: Type.Optional(Type.Integer({ minimum: 0 })),
    contextPercent: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("completed"),
    agentId: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    responseText: Type.String(),
    aborted: Type.Boolean(),
    turnLimited: Type.Boolean(),
    contextPercent: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("failed"),
    agentId: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    error: Type.String(),
  }, { additionalProperties: false }),
]);

export type SessionStartRequest = Static<typeof SessionStartRequestSchema>;
export type SessionContinueRequest = Static<typeof SessionContinueRequestSchema>;
export type SessionSteerRequest = Static<typeof SessionSteerRequestSchema>;
export type SessionAbortRequest = Static<typeof SessionAbortRequestSchema>;
export type SessionCloseRequest = Static<typeof SessionCloseRequestSchema>;
export type SessionInspectRequest = Static<typeof SessionInspectRequestSchema>;
export type SessionSteerResult = Static<typeof SessionSteerResultSchema>;
export type SessionInspectResult = Static<typeof SessionInspectResultSchema>;
export type SessionEvent = Static<typeof SessionEventSchema>;
