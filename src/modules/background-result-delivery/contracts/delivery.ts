import { Type, type Static } from "typebox";
import { AgentStatusSchema } from "../../subagent-runtime/public.js";

/**
 * The status a persisted record carries is the run's lifecycle status, owned by
 * the runtime. Aliased rather than restated: a private copy would keep
 * validating records after the runtime added or renamed a state, and the drift
 * would only show up as a record this module refuses to read back.
 */
export const DeliveryStatusSchema = AgentStatusSchema;

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

/**
 * Registers the parent entry a background spawn was launched from. The host
 * caches the active branch only at turn boundaries, and the entry that holds
 * the Agent call is created inside the turn — so without this seed the run's
 * own origin looks off-branch when it completes, and the result is hidden
 * from the session that asked for it.
 */
export const TrackOriginCommandSchema = Type.Object({
  kind: Type.Literal("track-origin"),
  originEntryId: Type.String({ minLength: 1 }),
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
  TrackOriginCommandSchema,
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

export const DeliveryEventSchema = Type.Union([
  Type.Object({
    type: Type.Literal("persisted"),
    deliveryId: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("fallback-retained"),
    deliveryId: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("hidden"),
    deliveryId: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("wake-requested"),
    deliveryIds: Type.Array(Type.String({ minLength: 1 })),
    mode: Type.Union([Type.Literal("turn"), Type.Literal("follow-up")]),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("wake-failed"),
    deliveryIds: Type.Array(Type.String({ minLength: 1 })),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("injected"),
    deliveryIds: Type.Array(Type.String({ minLength: 1 })),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("acknowledged"),
    deliveryIds: Type.Array(Type.String({ minLength: 1 })),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("restored"),
    deliveryIds: Type.Array(Type.String({ minLength: 1 })),
  }, { additionalProperties: false }),
]);

export const DeliveryCommandResultSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    snapshot: DeliverySnapshotSchema,
    events: Type.Array(DeliveryEventSchema),
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
      code: Type.Literal("invalid-command"),
      message: Type.String(),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
]);

export type DeliveryStatus = Static<typeof DeliveryStatusSchema>;
export type BackgroundResultRecord = Static<typeof BackgroundResultRecordSchema>;
export type ParentPhase = Static<typeof ParentPhaseSchema>;
export type DeliveryCommand = Static<typeof DeliveryCommandSchema>;
export type DeliverySnapshot = Static<typeof DeliverySnapshotSchema>;
export type DeliveryEvent = Static<typeof DeliveryEventSchema>;
export type DeliveryCommandResult = Static<typeof DeliveryCommandResultSchema>;
