import { Type, type Static } from "typebox";
// The prompt module owns what a mode means; the settings page only offers the
// choices assembly can honor.
import { SystemPromptModeSchema } from "../../prompt/public.js";
import { ThinkingLevelSchema } from "../../model-access/public.js";
import {
  AgentStatusSchema,
  ConcurrencyLimitsUpdateSchema,
  DebugFaultKindSchema,
} from "../../subagent-runtime/public.js";

// ── Workflow surface ──────────────────────────────────────────────

// Row kinds drive the renderer's widget choice and the value contract:
// toggle/choice cycle through `choices`, numeric opens an integer input with
// `min`/`fallback` hints, action fires with its single choice as the value,
// limit edits-or-removes a keyed override (`update-limit`), picker selects a
// key from `choices` and asks for a limit (`add-limit`), note is a
// non-selectable display-only row.
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
    Type.Literal("note"),
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

export const SettingsEffectSchema = Type.Union([
  Type.Object({ kind: Type.Literal("close") }, { additionalProperties: false }),
]);

const SettingsErrorSchema = Type.Object({
  code: Type.Union([
    Type.Literal("invalid-command"),
    Type.Literal("unknown-row"),
    Type.Literal("invalid-value"),
    // A page projection that does not satisfy `SettingsSnapshotSchema`. Owner
    // ports are the likely source, and the renderer is the wrong place to find
    // out: it would draw a half-built page and let the user act on it.
    Type.Literal("invalid-snapshot"),
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

// A failed persist names the two ways a save can refuse: the disk
// rejected the write, or the revision moved while the page was open. The
// field is optional because session-local owners (debug) and message-only
// ports still speak without a code; requiring it would turn those into
// contract crashes — the same class of lie a persist failure used to
// become. Revisit if every owner write carries a configuration commit code.
export const SettingsUpdateResultSchema = Type.Union([
  Type.Object({ ok: Type.Literal(true) }, { additionalProperties: false }),
  Type.Object({
    ok: Type.Literal(false),
    message: Type.String({ minLength: 1 }),
    code: Type.Optional(Type.Union([
      Type.Literal("persistence-failure"),
      Type.Literal("revision-conflict"),
    ])),
  }, { additionalProperties: false }),
]);

export const RootSummariesSchema = Type.Object({
  modelAccessEnabled: Type.Boolean(),
  concurrencyDefault: Type.Number(),
}, { additionalProperties: false });

export const SpawnSettingsViewSchema = Type.Object({
  forceBackground: Type.Boolean(),
  graceTurns: Type.Integer({ minimum: 0 }),
  // Owner-provided capability default, used when the numeric input is
  // submitted empty; the page never hardcodes policy defaults.
  graceTurnsFallback: Type.Integer({ minimum: 0 }),
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

// Runtime owns the persisted concurrency update. A second union here is
// how a settings page could commit a shape replaceLimits later refuses.
export const ConcurrencyLimitUpdateSchema = ConcurrencyLimitsUpdateSchema;

// ── Debug page boundary ───────────────────────────────────────────
// The one-shot fault stays UI-only and unpersisted (REQ-RUNTIME-007); the
// page only arms/clears it and mirrors runtime-reported provenance.

// Runtime owns the status and fault vocabularies. A restated Type.String()
// here is how a debug page could arm a label the child screen cannot paint.
export const DebugFaultSchema = DebugFaultKindSchema;
export const DebugStatusPreviewSchema = AgentStatusSchema;

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
  status: AgentStatusSchema,
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

// ── Model access boundary ─────────────────────────────────────────
// Views carry only what the pages display; the decision tables, fragment
// shape, and rule transitions stay in the model-access module behind the
// owner port (REQ-SETTINGS-002). Parent keys are "" when no parent model is
// active so every view stays plain serializable JSON.

export const ModelAccessUnavailableProviderSchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  routingEnabled: Type.Boolean(),
  // Agent types with saved rules for this provider; drives counts and the
  // delete confirmation listing.
  ruleTypes: Type.Array(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

export const ModelAccessUnavailableRuleSchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  agentType: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const ModelAccessRootViewSchema = Type.Object({
  enabled: Type.Boolean(),
  parentModelKey: Type.String(),
  enabledProviderCount: Type.Integer({ minimum: 0 }),
  configuredAgentCount: Type.Integer({ minimum: 0 }),
  unavailableProviders: Type.Array(ModelAccessUnavailableProviderSchema),
  unavailableRules: Type.Array(ModelAccessUnavailableRuleSchema),
}, { additionalProperties: false });

export const ModelAccessAgentRowSchema = Type.Object({
  type: Type.String({ minLength: 1 }),
  registered: Type.Boolean(),
  summary: Type.String(),
}, { additionalProperties: false });

export const ModelAccessAgentDetailViewSchema = Type.Object({
  parentModelKey: Type.String(),
  parentAllowed: Type.Boolean(),
  // Effective default thinking level for parent use; "" when unavailable.
  parentDefaultLevel: Type.Union([ThinkingLevelSchema, Type.Literal("")]),
  // Effective alternate providers; empty while routing is disabled.
  providers: Type.Array(Type.String()),
  thinkingTargetCount: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export const ModelAccessProvidersViewSchema = Type.Object({
  parentModelKey: Type.String(),
  providers: Type.Array(Type.Object({
    provider: Type.String({ minLength: 1 }),
    enabled: Type.Boolean(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export const ModelAccessModelsViewSchema = Type.Object({
  parentModelKey: Type.String(),
  allModels: Type.Boolean(),
  models: Type.Array(Type.Object({
    id: Type.String({ minLength: 1 }),
    granted: Type.Boolean(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export const ModelAccessThinkingTargetSchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  parent: Type.Boolean(),
}, { additionalProperties: false });

export const ModelAccessThinkingViewSchema = Type.Object({
  levels: Type.Array(Type.Object({
    level: ThinkingLevelSchema,
    allowed: Type.Boolean(),
    isDefault: Type.Boolean(),
  }, { additionalProperties: false })),
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
export type ModelAccessUnavailableProvider = Static<typeof ModelAccessUnavailableProviderSchema>;
export type ModelAccessUnavailableRule = Static<typeof ModelAccessUnavailableRuleSchema>;
export type ModelAccessRootView = Static<typeof ModelAccessRootViewSchema>;
export type ModelAccessAgentRow = Static<typeof ModelAccessAgentRowSchema>;
export type ModelAccessAgentDetailView = Static<typeof ModelAccessAgentDetailViewSchema>;
export type ModelAccessProvidersView = Static<typeof ModelAccessProvidersViewSchema>;
export type ModelAccessModelsView = Static<typeof ModelAccessModelsViewSchema>;
export type ModelAccessThinkingTarget = Static<typeof ModelAccessThinkingTargetSchema>;
export type ModelAccessThinkingView = Static<typeof ModelAccessThinkingViewSchema>;
