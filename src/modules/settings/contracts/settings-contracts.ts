import { Type, type Static } from "typebox";

// ── Workflow surface ──────────────────────────────────────────────

export const SettingsRowSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal("category"), Type.Literal("toggle")]),
  label: Type.String({ minLength: 1 }),
  detail: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
  choices: Type.Optional(Type.Array(Type.String(), { minItems: 2 })),
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
