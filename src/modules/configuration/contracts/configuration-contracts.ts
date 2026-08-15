import { Type, type Static } from "typebox";

export const JsonValueSchema = Type.Cyclic({
  JsonValue: Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String(),
    Type.Array(Type.Ref("JsonValue")),
    Type.Record(Type.String(), Type.Ref("JsonValue")),
  ]),
}, "JsonValue");

export const JsonObjectSchema = Type.Record(Type.String(), JsonValueSchema);

/** Runtime metadata about the persisted document; never written to disk. */
export const ConfigurationDocumentStatusSchema = Type.Union([
  Type.Literal("absent"),
  Type.Literal("loaded"),
  Type.Literal("malformed"),
]);

/**
 * Repository load outcome. `absent` is strictly ENOENT; every other read
 * failure — bad JSON, non-object content, unreadable storage — is `malformed`
 * with a presentable message, so a project layer can refuse writes instead of
 * silently overwriting a file it could not read.
 */
export const ConfigurationDocumentLoadResultSchema = Type.Union([
  Type.Object({
    status: Type.Literal("loaded"),
    document: JsonObjectSchema,
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal("absent"),
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal("malformed"),
    message: Type.String(),
  }, { additionalProperties: false }),
]);

export const ConfigurationDocumentSnapshotSchema = Type.Object({
  revision: Type.Integer({ minimum: 0 }),
  document: JsonObjectSchema,
}, { additionalProperties: false });

export const ReadConfigurationValueCommandSchema = Type.Object({
  kind: Type.Literal("read-value"),
  path: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
}, { additionalProperties: false });

// One transaction replaces the owning capability's keys inside one physical
// section. Assignments carry the full canonical fragment content; keys not
// listed keep their persisted value, so co-owned sections (agent) stay intact.
// Removals delete named keys from the section (an emptied section object is
// kept); a key may not appear in both assignments and removals.
export const CommitConfigurationFragmentCommandSchema = Type.Object({
  kind: Type.Literal("commit-fragment"),
  expectedRevision: Type.Integer({ minimum: 0 }),
  section: Type.String({ minLength: 1 }),
  assignments: Type.Record(Type.String(), JsonValueSchema),
  removals: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
}, { additionalProperties: false });

export const ReloadConfigurationCommandSchema = Type.Object({
  kind: Type.Literal("reload"),
}, { additionalProperties: false });

export const ConfigurationCommandSchema = Type.Union([
  ReadConfigurationValueCommandSchema,
  CommitConfigurationFragmentCommandSchema,
  ReloadConfigurationCommandSchema,
]);

// The ways a fragment commit can refuse a save. Settings embeds this
// schema so a new commit code is either added here — and accepted on the
// page — or stays a facade error, never an invalid-snapshot that closes
// /agents. `document-malformed` is returned only under the read-only
// malformed policy (project layer); the global reset-on-commit policy
// keeps overwriting.
export const ConfigurationCommitFailureCodeSchema = Type.Union([
  Type.Literal("persistence-failure"),
  Type.Literal("revision-conflict"),
  Type.Literal("document-malformed"),
]);

const ConfigurationErrorSchema = Type.Object({
  code: Type.Union([
    Type.Literal("invalid-command"),
    Type.Literal("repository-failure"),
    Type.Literal("invalid-repository-result"),
    ConfigurationCommitFailureCodeSchema,
  ]),
  message: Type.String(),
}, { additionalProperties: false });

const ConfigurationFailureSchema = Type.Object({
  ok: Type.Literal(false),
  error: ConfigurationErrorSchema,
}, { additionalProperties: false });

export const ReadConfigurationValueResultSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    revision: Type.Integer({ minimum: 0 }),
    found: Type.Literal(true),
    value: JsonValueSchema,
  }, { additionalProperties: false }),
  Type.Object({
    ok: Type.Literal(true),
    revision: Type.Integer({ minimum: 0 }),
    found: Type.Literal(false),
  }, { additionalProperties: false }),
  ConfigurationFailureSchema,
]);

export const CommitConfigurationFragmentResultSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    revision: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
  ConfigurationFailureSchema,
]);

export const ReloadConfigurationSuccessSchema = Type.Object({
  ok: Type.Literal(true),
  revision: Type.Integer({ minimum: 0 }),
  status: ConfigurationDocumentStatusSchema,
}, { additionalProperties: false });

export const ReloadConfigurationResultSchema = Type.Union([
  ReloadConfigurationSuccessSchema,
  ConfigurationFailureSchema,
]);

export const ConfigurationResultSchema = Type.Union([
  ReadConfigurationValueResultSchema,
  CommitConfigurationFragmentResultSchema,
  ReloadConfigurationResultSchema,
]);

// Candidates for one operational setting, already read from their sources by
// the composition root. Only operational settings pass through this contract;
// interactive product policies never receive environment or .env candidates.
export const OperationalValueCandidatesSchema = Type.Object({
  environment: Type.Optional(Type.String()),
  dotEnv: Type.Optional(Type.String()),
  configured: Type.Optional(Type.String()),
  fallback: Type.String(),
}, { additionalProperties: false });

export type JsonValue = Static<typeof JsonValueSchema>;
export type JsonObject = Static<typeof JsonObjectSchema>;
export type ConfigurationDocumentStatus = Static<typeof ConfigurationDocumentStatusSchema>;
export type ConfigurationDocumentLoadResult = Static<typeof ConfigurationDocumentLoadResultSchema>;
export type ConfigurationDocumentSnapshot = Static<typeof ConfigurationDocumentSnapshotSchema>;
export type ReadConfigurationValueCommand = Static<typeof ReadConfigurationValueCommandSchema>;
export type CommitConfigurationFragmentCommand = Static<typeof CommitConfigurationFragmentCommandSchema>;
export type ReloadConfigurationCommand = Static<typeof ReloadConfigurationCommandSchema>;
export type ConfigurationCommand = Static<typeof ConfigurationCommandSchema>;
export type ReadConfigurationValueResult = Static<typeof ReadConfigurationValueResultSchema>;
export type CommitConfigurationFragmentResult = Static<typeof CommitConfigurationFragmentResultSchema>;
export type ReloadConfigurationResult = Static<typeof ReloadConfigurationResultSchema>;
export type ConfigurationResult = Static<typeof ConfigurationResultSchema>;
export type ConfigurationCommitFailureCode = Static<typeof ConfigurationCommitFailureCodeSchema>;
export type OperationalValueCandidates = Static<typeof OperationalValueCandidatesSchema>;
