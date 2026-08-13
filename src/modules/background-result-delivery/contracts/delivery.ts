import { Type, type Static } from "typebox";

export const DeliveryStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("turn_limited"),
  Type.Literal("aborted"),
  Type.Literal("stopped"),
  Type.Literal("error"),
]);

export const BackgroundResultRecordSchema = Type.Object({
  deliveryId: Type.String({ minLength: 1 }),
  parentSessionId: Type.String({ minLength: 1 }),
  originEntryId: Type.Union([Type.String(), Type.Null()]),
  agentId: Type.String({ minLength: 1 }),
  type: Type.String({ minLength: 1 }),
  status: DeliveryStatusSchema,
  result: Type.String(),
  error: Type.Union([Type.String(), Type.Null()]),
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  createdAt: Type.Integer(),
}, { additionalProperties: false });

export const ParentPhaseSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("preflight"),
  Type.Literal("running"),
  Type.Literal("settling"),
]);

export const RecordTerminalCommandSchema = Type.Object({
  kind: Type.Literal("record-terminal"),
  record: BackgroundResultRecordSchema,
  stillPresent: Type.Boolean(),
}, { additionalProperties: false });

export const ParentPreflightCommandSchema = Type.Object({
  kind: Type.Literal("parent-preflight"),
}, { additionalProperties: false });

export const ParentStartCommandSchema = Type.Object({
  kind: Type.Literal("parent-start"),
}, { additionalProperties: false });

export const ParentEndCommandSchema = Type.Object({
  kind: Type.Literal("parent-end"),
  succeeded: Type.Boolean(),
}, { additionalProperties: false });

export const ParentSettledCommandSchema = Type.Object({
  kind: Type.Literal("parent-settled"),
}, { additionalProperties: false });

export const RestoreCommandSchema = Type.Object({
  kind: Type.Literal("restore"),
}, { additionalProperties: false });

export const SessionTreeCommandSchema = Type.Object({
  kind: Type.Literal("session-tree"),
}, { additionalProperties: false });

export const MarkPresentedCommandSchema = Type.Object({
  kind: Type.Literal("mark-presented"),
  deliveryId: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const InspectDeliveryCommandSchema = Type.Object({
  kind: Type.Literal("inspect"),
  agentId: Type.Optional(Type.String({ minLength: 1 })),
  deliveryId: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

export const DisposeDeliveryCommandSchema = Type.Object({
  kind: Type.Literal("dispose"),
}, { additionalProperties: false });

export const DeliveryCommandSchema = Type.Union([
  RecordTerminalCommandSchema,
  ParentPreflightCommandSchema,
  ParentStartCommandSchema,
  ParentEndCommandSchema,
  ParentSettledCommandSchema,
  RestoreCommandSchema,
  SessionTreeCommandSchema,
  MarkPresentedCommandSchema,
  InspectDeliveryCommandSchema,
  DisposeDeliveryCommandSchema,
]);

export const DeliverySnapshotSchema = Type.Object({
  parentSessionId: Type.String(),
  parentRunPhase: ParentPhaseSchema,
  parentWakeActive: Type.Boolean(),
  lastWakeFailed: Type.Boolean(),
  pending: Type.Array(BackgroundResultRecordSchema),
  fallback: Type.Array(BackgroundResultRecordSchema),
  visiblePendingCount: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

export const DeliveryCommandResultSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    snapshot: DeliverySnapshotSchema,
    injection: Type.Optional(Type.Object({
      customType: Type.String(),
      content: Type.String(),
      display: Type.Literal(false),
    }, { additionalProperties: false })),
    stored: Type.Optional(BackgroundResultRecordSchema),
  }, { additionalProperties: false }),
  Type.Object({
    ok: Type.Literal(false),
    error: Type.Object({
      code: Type.Union([
        Type.Literal("invalid-command"),
        Type.Literal("disposed"),
        Type.Literal("repository-failure"),
      ]),
      message: Type.String(),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
]);

export type DeliveryStatus = Static<typeof DeliveryStatusSchema>;
export type BackgroundResultRecord = Static<typeof BackgroundResultRecordSchema>;
export type ParentPhase = Static<typeof ParentPhaseSchema>;
export type DeliveryCommand = Static<typeof DeliveryCommandSchema>;
export type DeliverySnapshot = Static<typeof DeliverySnapshotSchema>;
export type DeliveryCommandResult = Static<typeof DeliveryCommandResultSchema>;
