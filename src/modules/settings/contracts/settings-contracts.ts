import { Type, type Static } from "typebox";

// ── Workflow surface ──────────────────────────────────────────────

// Row kinds drive the renderer's widget choice and the value contract:
// toggle/choice cycle through `choices`, numeric opens an integer input with
// `min`/`fallback` hints, action fires with its single choice as the value.
export const SettingsRowSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  kind: Type.Union([
    Type.Literal("category"),
    Type.Literal("toggle"),
    Type.Literal("choice"),
    Type.Literal("numeric"),
    Type.Literal("action"),
  ]),
  label: Type.String({ minLength: 1 }),
  detail: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
  choices: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  min: Type.Optional(Type.Integer()),
  fallback: Type.Optional(Type.Integer()),
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
