import { Type, type Static } from "typebox";

export const ChildStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("turn_limited"),
  Type.Literal("aborted"),
  Type.Literal("stopped"),
  Type.Literal("error"),
]);

export const ChildRecordSummarySchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  status: ChildStatusSchema,
  type: Type.String({ minLength: 1 }),
  description: Type.String(),
  pinned: Type.Boolean(),
}, { additionalProperties: false });

export const ReplaceRecordsCommandSchema = Type.Object({
  kind: Type.Literal("replace-records"),
  records: Type.Array(ChildRecordSummarySchema),
  pendingResultCount: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

export const SelectChildCommandSchema = Type.Object({
  kind: Type.Literal("select"),
  agentId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
}, { additionalProperties: false });

export const ToggleFoldCommandSchema = Type.Object({
  kind: Type.Literal("toggle-fold"),
}, { additionalProperties: false });

export const InspectNavigatorCommandSchema = Type.Object({
  kind: Type.Literal("inspect"),
}, { additionalProperties: false });

export const NavigatorCommandSchema = Type.Union([
  ReplaceRecordsCommandSchema,
  SelectChildCommandSchema,
  ToggleFoldCommandSchema,
  InspectNavigatorCommandSchema,
]);

export const NavigatorSnapshotSchema = Type.Object({
  selectedAgentId: Type.Union([Type.String(), Type.Null()]),
  highlightedAgentId: Type.Union([Type.String(), Type.Null()]),
  listExpanded: Type.Boolean(),
  listFocused: Type.Boolean(),
  visible: Type.Boolean(),
  pendingResultCount: Type.Optional(Type.Integer({ minimum: 1 })),
  records: Type.Array(ChildRecordSummarySchema),
}, { additionalProperties: false });

export const NavigatorCommandResultSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    snapshot: NavigatorSnapshotSchema,
  }, { additionalProperties: false }),
  Type.Object({
    ok: Type.Literal(false),
    error: Type.Object({
      code: Type.Union([
        Type.Literal("invalid-command"),
        Type.Literal("not-found"),
      ]),
      message: Type.String(),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
]);

export type ChildStatus = Static<typeof ChildStatusSchema>;
export type ChildRecordSummary = Static<typeof ChildRecordSummarySchema>;
export type NavigatorCommand = Static<typeof NavigatorCommandSchema>;
export type NavigatorSnapshot = Static<typeof NavigatorSnapshotSchema>;
export type NavigatorCommandResult = Static<typeof NavigatorCommandResultSchema>;
