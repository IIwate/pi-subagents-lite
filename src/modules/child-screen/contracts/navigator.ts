import { Type, type Static } from "typebox";

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

export interface TextLayout {
  visibleWidth(text: string): number;
  truncate(text: string, width: number, ellipsis?: string): string;
  wrap(text: string, width: number): string[];
}

export const ChildStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("turn_limited"),
  Type.Literal("aborted"),
  Type.Literal("stopped"),
  Type.Literal("error"),
]);

export const ChildSessionViewSchema = Type.Object({
  found: Type.Boolean(),
  live: Type.Boolean(),
  streaming: Type.Boolean(),
  modelId: Type.Optional(Type.String()),
  provider: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(Type.String()),
  contextPercent: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  messages: Type.Array(JsonValueSchema),
  streamingMessage: Type.Optional(JsonValueSchema),
}, { additionalProperties: false });

export const ChildRecordSummarySchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  status: ChildStatusSchema,
  type: Type.String({ minLength: 1 }),
  description: Type.String(),
  pinned: Type.Boolean(),
  displayName: Type.Optional(Type.String()),
  startedAt: Type.Optional(Type.Integer()),
  completedAt: Type.Optional(Type.Integer()),
  debugFaultKind: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  invocation: Type.Optional(Type.Object({
    providerName: Type.Optional(Type.String()),
    modelName: Type.Optional(Type.String()),
    thinkingLevel: Type.Optional(Type.String()),
  }, { additionalProperties: false })),
  stats: Type.Optional(Type.Object({
    toolUses: Type.Integer({ minimum: 0 }),
    turnCount: Type.Optional(Type.Integer({ minimum: 0 })),
    maxTurns: Type.Optional(Type.Integer()),
    input: Type.Number(),
    output: Type.Number(),
    cost: Type.Number(),
    contextPercent: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    compactionCount: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false })),
  session: Type.Optional(ChildSessionViewSchema),
}, { additionalProperties: false });

export const StatsVisibilitySchema = Type.Object({
  showTools: Type.Optional(Type.Boolean()),
  showTurns: Type.Optional(Type.Boolean()),
  showInput: Type.Optional(Type.Boolean()),
  showOutput: Type.Optional(Type.Boolean()),
  showContext: Type.Optional(Type.Boolean()),
  showCost: Type.Optional(Type.Boolean()),
  showTime: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const NavigatorKeySchema = Type.Union([
  Type.Literal("down"),
  Type.Literal("up"),
  Type.Literal("enter"),
  Type.Literal("escape"),
  Type.Literal("space"),
  Type.Literal("ctrl-d"),
  Type.Literal("ctrl-c"),
  Type.Literal("printable"),
]);

export const ReplaceRecordsCommandSchema = Type.Object({
  kind: Type.Literal("replace-records"),
  records: Type.Array(ChildRecordSummarySchema),
  pendingResultCount: Type.Optional(Type.Integer({ minimum: 1 })),
  highlightIndex: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });

export const SelectChildCommandSchema = Type.Object({
  kind: Type.Literal("select"),
  agentId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
}, { additionalProperties: false });

export const ToggleFoldCommandSchema = Type.Object({
  kind: Type.Literal("toggle-fold"),
}, { additionalProperties: false });

export const KeyCommandSchema = Type.Object({
  kind: Type.Literal("key"),
  key: NavigatorKeySchema,
  editorEmpty: Type.Boolean(),
}, { additionalProperties: false });

export const SetStatsVisibilityCommandSchema = Type.Object({
  kind: Type.Literal("set-stats-visibility"),
  visibility: StatsVisibilitySchema,
}, { additionalProperties: false });

export const SetDebugPreviewCommandSchema = Type.Object({
  kind: Type.Literal("set-debug-preview"),
  status: Type.Optional(ChildStatusSchema),
}, { additionalProperties: false });

export const SetInteractionNoticeCommandSchema = Type.Object({
  kind: Type.Literal("set-interaction-notice"),
  notice: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

export const BeginInteractionCommandSchema = Type.Object({
  kind: Type.Literal("begin-interaction"),
  agentId: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const ProjectCommandSchema = Type.Object({
  kind: Type.Literal("project"),
  columns: Type.Integer({ minimum: 1 }),
  rows: Type.Integer({ minimum: 1 }),
  now: Type.Integer(),
}, { additionalProperties: false });

export const InspectNavigatorCommandSchema = Type.Object({
  kind: Type.Literal("inspect"),
}, { additionalProperties: false });

export const NavigatorCommandSchema = Type.Union([
  ReplaceRecordsCommandSchema,
  SelectChildCommandSchema,
  ToggleFoldCommandSchema,
  KeyCommandSchema,
  SetStatsVisibilityCommandSchema,
  SetDebugPreviewCommandSchema,
  SetInteractionNoticeCommandSchema,
  BeginInteractionCommandSchema,
  ProjectCommandSchema,
  InspectNavigatorCommandSchema,
]);

export const LinePartSchema = Type.Object({
  text: Type.String(),
  color: Type.Optional(Type.String()),
  bold: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const RenderedLineSchema = Type.Object({
  parts: Type.Array(LinePartSchema),
}, { additionalProperties: false });

export const NavigatorSnapshotSchema = Type.Object({
  selectedAgentId: Type.Union([Type.String(), Type.Null()]),
  highlightedAgentId: Type.Union([Type.String(), Type.Null()]),
  listExpanded: Type.Boolean(),
  listFocused: Type.Boolean(),
  confirmingClearId: Type.Union([Type.String(), Type.Null()]),
  interactionNotice: Type.Optional(Type.String()),
  interactionRequestId: Type.Integer({ minimum: 0 }),
  visible: Type.Boolean(),
  pendingResultCount: Type.Optional(Type.Integer({ minimum: 1 })),
  records: Type.Array(ChildRecordSummarySchema),
  listLines: Type.Optional(Type.Array(RenderedLineSchema)),
  footerStatus: Type.Optional(Type.Array(LinePartSchema)),
  transcriptLines: Type.Optional(Type.Array(RenderedLineSchema)),
}, { additionalProperties: false });

export const NavigatorNotifySchema = Type.Object({
  message: Type.String(),
  level: Type.Union([Type.Literal("warning"), Type.Literal("info")]),
}, { additionalProperties: false });

export const NavigatorEffectSchema = Type.Union([
  Type.Object({
    type: Type.Literal("toggle-pin"),
    agentId: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("clear"),
    agentId: Type.String({ minLength: 1 }),
    index: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
]);

export const NavigatorCommandResultSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    snapshot: NavigatorSnapshotSchema,
    consume: Type.Optional(Type.Boolean()),
    notify: Type.Optional(NavigatorNotifySchema),
    effect: Type.Optional(NavigatorEffectSchema),
    interactionRequestId: Type.Optional(Type.Integer()),
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
export type ChildSessionView = Static<typeof ChildSessionViewSchema>;
export type ChildRecordSummary = Static<typeof ChildRecordSummarySchema>;
export type StatsVisibility = Static<typeof StatsVisibilitySchema>;
export type NavigatorKey = Static<typeof NavigatorKeySchema>;
export type NavigatorCommand = Static<typeof NavigatorCommandSchema>;
export type LinePart = Static<typeof LinePartSchema>;
export type RenderedLine = Static<typeof RenderedLineSchema>;
export type NavigatorSnapshot = Static<typeof NavigatorSnapshotSchema>;
export type NavigatorNotify = Static<typeof NavigatorNotifySchema>;
export type NavigatorEffect = Static<typeof NavigatorEffectSchema>;
export type NavigatorCommandResult = Static<typeof NavigatorCommandResultSchema>;
