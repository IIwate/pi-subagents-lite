import { Type, type Static } from "typebox";

// ── Workflow surface ──────────────────────────────────────────────

// Row kinds drive the renderer's widget choice and the value contract:
// toggle/choice cycle through `choices`, numeric opens an integer input with
// `min`/`fallback` hints, action fires with its single choice as the value,
// limit edits-or-removes a keyed override (`update-limit`), picker selects a
// key from `choices` and asks for a limit (`add-limit`).
export const SettingsRowSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  kind: Type.Union([
    Type.Literal("category"),
    Type.Literal("toggle"),
    Type.Literal("choice"),
    Type.Literal("numeric"),
    Type.Literal("action"),
    Type.Literal("limit"),
    Type.Literal("picker"),
  ]),
  label: Type.String({ minLength: 1 }),
  detail: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
  choices: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  min: Type.Optional(Type.Integer()),
  fallback: Type.Optional(Type.Integer()),
  // Raw editable value when `value` is a formatted display string.
  input: Type.Optional(Type.String()),
  // Confirmation question the renderer must ask before firing an action row.
  confirm: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

export const SettingsNoticeSchema = Type.Object({
  severity: Type.Union([Type.Literal("info"), Type.Literal("error")]),
  message: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

// `presentation` tells the renderer which widget family a page needs (menu of
// categories vs. editable form). It is part of the contract so the platform
// host never infers page shape from row kinds.
export const SettingsSnapshotSchema = Type.Object({
  page: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  presentation: Type.Union([Type.Literal("menu"), Type.Literal("form")]),
  rows: Type.Array(SettingsRowSchema),
  notice: Type.Optional(SettingsNoticeSchema),
}, { additionalProperties: false });

export const SettingsCommandSchema = Type.Union([
  Type.Object({ kind: Type.Literal("open") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("select"), id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("set-value"),
    id: Type.String({ minLength: 1 }),
    value: Type.String(),
  }, { additionalProperties: false }),
  // Keyed-limit workflow (limit and picker rows): null removes the override.
  Type.Object({
    kind: Type.Literal("update-limit"),
    id: Type.String({ minLength: 1 }),
    limit: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("add-limit"),
    id: Type.String({ minLength: 1 }),
    key: Type.String({ minLength: 1 }),
    limit: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("back") }, { additionalProperties: false }),
]);

// "open-legacy-category" exists only while un-migrated categories still run
// their monolithic Pi menus. Each settings slice deletes its category from
// this effect; the effect itself is deleted with the last legacy menu.
export const SettingsEffectSchema = Type.Union([
  Type.Object({ kind: Type.Literal("close") }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("open-legacy-category"),
    category: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
]);

const SettingsErrorSchema = Type.Object({
  code: Type.Union([
    Type.Literal("invalid-command"),
    Type.Literal("unknown-row"),
    Type.Literal("invalid-value"),
  ]),
  message: Type.String(),
}, { additionalProperties: false });

export const SettingsResultSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    snapshot: SettingsSnapshotSchema,
    effect: Type.Optional(SettingsEffectSchema),
  }, { additionalProperties: false }),
  Type.Object({
    ok: Type.Literal(false),
    error: SettingsErrorSchema,
  }, { additionalProperties: false }),
]);

// ── Owner-facing fragments ────────────────────────────────────────

export const DisplayToggleIdSchema = Type.Union([
  Type.Literal("expandListByDefault"),
  Type.Literal("showTools"),
  Type.Literal("showTurns"),
  Type.Literal("showInput"),
  Type.Literal("showOutput"),
  Type.Literal("showContext"),
  Type.Literal("showCost"),
  Type.Literal("showTime"),
]);

export const DisplaySettingsViewSchema = Type.Object({
  expandListByDefault: Type.Boolean(),
  showTools: Type.Boolean(),
  showTurns: Type.Boolean(),
  showInput: Type.Boolean(),
  showOutput: Type.Boolean(),
  showContext: Type.Boolean(),
  showCost: Type.Boolean(),
  showTime: Type.Boolean(),
}, { additionalProperties: false });

export const SettingsUpdateResultSchema = Type.Union([
  Type.Object({ ok: Type.Literal(true) }, { additionalProperties: false }),
  Type.Object({
    ok: Type.Literal(false),
    message: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
]);

export const RootSummariesSchema = Type.Object({
  modelAccessEnabled: Type.Boolean(),
  concurrencyDefault: Type.Number(),
}, { additionalProperties: false });

export const SpawnSettingsViewSchema = Type.Object({
  forceBackground: Type.Boolean(),
  graceTurns: Type.Integer({ minimum: 0 }),
  disableDefaultAgents: Type.Boolean(),
}, { additionalProperties: false });

export const SpawnSettingUpdateSchema = Type.Union([
  Type.Object({
    id: Type.Union([Type.Literal("forceBackground"), Type.Literal("disableDefaultAgents")]),
    value: Type.Boolean(),
  }, { additionalProperties: false }),
  Type.Object({
    id: Type.Literal("graceTurns"),
    value: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
]);

export const SystemPromptModeSchema = Type.Union([
  Type.Literal("replace"),
  Type.Literal("inherit"),
  Type.Literal("custom"),
]);

export const PromptSettingsViewSchema = Type.Object({
  systemPromptMode: SystemPromptModeSchema,
  includeContextFiles: Type.Boolean(),
  loadSkillsImplicitly: Type.Boolean(),
  loadExtensionsImplicitly: Type.Boolean(),
  customPromptPath: Type.String({ minLength: 1 }),
  customPromptFileExists: Type.Boolean(),
}, { additionalProperties: false });

export const PromptSettingUpdateSchema = Type.Union([
  Type.Object({
    id: Type.Literal("systemPromptMode"),
    value: SystemPromptModeSchema,
  }, { additionalProperties: false }),
  Type.Object({
    id: Type.Union([
      Type.Literal("includeContextFiles"),
      Type.Literal("loadSkillsImplicitly"),
      Type.Literal("loadExtensionsImplicitly"),
    ]),
    value: Type.Boolean(),
  }, { additionalProperties: false }),
]);

// Concurrency view: saved overrides plus the active provider/model inventory
// the owner computed, so the page can split active, inactive, and addable
// rows without knowing where the inventory comes from.
export const ConcurrencySettingsViewSchema = Type.Object({
  defaultLimit: Type.Integer({ minimum: 1 }),
  factoryDefaultLimit: Type.Integer({ minimum: 1 }),
  providerLimits: Type.Record(Type.String(), Type.Integer({ minimum: 1 })),
  modelLimits: Type.Record(Type.String(), Type.Integer({ minimum: 1 })),
  activeProviders: Type.Array(Type.String()),
  activeModels: Type.Array(Type.String()),
}, { additionalProperties: false });

export const ConcurrencyLimitUpdateSchema = Type.Union([
  Type.Object({
    scope: Type.Literal("default"),
    limit: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    scope: Type.Union([Type.Literal("provider"), Type.Literal("model")]),
    key: Type.String({ minLength: 1 }),
    limit: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  }, { additionalProperties: false }),
  Type.Object({
    scope: Type.Literal("reset"),
  }, { additionalProperties: false }),
]);

// ── Debug page boundary ───────────────────────────────────────────
// The one-shot fault stays UI-only and unpersisted (REQ-RUNTIME-007); the
// page only arms/clears it and mirrors runtime-reported provenance.

export const DebugFaultSchema = Type.Union([
  Type.Literal("output_blocked"),
  Type.Literal("provider_error"),
]);

// UI-only lifecycle presentation override for the child screen list.
export const DebugStatusPreviewSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("turn_limited"),
  Type.Literal("aborted"),
  Type.Literal("stopped"),
  Type.Literal("error"),
]);

export const DebugAgentTypeSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.String(),
  // Absent means the type may use all built-in tools.
  tools: Type.Optional(Type.Array(Type.String())),
  source: Type.Optional(Type.String()),
  hidden: Type.Boolean(),
}, { additionalProperties: false });

export const DebugRuntimeAgentSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  type: Type.String(),
  status: Type.String(),
  session: Type.Union([Type.Literal("live"), Type.Literal("none")]),
  settled: Type.Boolean(),
  resultPersisted: Type.Boolean(),
  resultConsumed: Type.Boolean(),
  debugFaultKind: Type.Optional(DebugFaultSchema),
  error: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const DebugDiagnosticsViewSchema = Type.Object({
  armedFault: Type.Optional(DebugFaultSchema),
  agents: Type.Array(DebugRuntimeAgentSchema),
}, { additionalProperties: false });

export const DebugSettingsViewSchema = Type.Object({
  armedFault: Type.Optional(DebugFaultSchema),
}, { additionalProperties: false });

export type SettingsRow = Static<typeof SettingsRowSchema>;
export type SettingsNotice = Static<typeof SettingsNoticeSchema>;
export type SettingsSnapshot = Static<typeof SettingsSnapshotSchema>;
export type SettingsCommand = Static<typeof SettingsCommandSchema>;
export type SettingsEffect = Static<typeof SettingsEffectSchema>;
export type SettingsResult = Static<typeof SettingsResultSchema>;
export type DisplayToggleId = Static<typeof DisplayToggleIdSchema>;
export type DisplaySettingsView = Static<typeof DisplaySettingsViewSchema>;
export type SettingsUpdateResult = Static<typeof SettingsUpdateResultSchema>;
export type RootSummaries = Static<typeof RootSummariesSchema>;
export type SpawnSettingsView = Static<typeof SpawnSettingsViewSchema>;
export type SpawnSettingUpdate = Static<typeof SpawnSettingUpdateSchema>;
export type SystemPromptMode = Static<typeof SystemPromptModeSchema>;
export type PromptSettingsView = Static<typeof PromptSettingsViewSchema>;
export type PromptSettingUpdate = Static<typeof PromptSettingUpdateSchema>;
export type ConcurrencySettingsView = Static<typeof ConcurrencySettingsViewSchema>;
export type ConcurrencyLimitUpdate = Static<typeof ConcurrencyLimitUpdateSchema>;
export type DebugFault = Static<typeof DebugFaultSchema>;
export type DebugStatusPreview = Static<typeof DebugStatusPreviewSchema>;
export type DebugAgentType = Static<typeof DebugAgentTypeSchema>;
export type DebugRuntimeAgent = Static<typeof DebugRuntimeAgentSchema>;
export type DebugDiagnosticsView = Static<typeof DebugDiagnosticsViewSchema>;
export type DebugSettingsView = Static<typeof DebugSettingsViewSchema>;
