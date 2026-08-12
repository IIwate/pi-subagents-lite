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

export const ConfigurationDocumentSnapshotSchema = Type.Object({
  revision: Type.Integer({ minimum: 0 }),
  document: JsonObjectSchema,
}, { additionalProperties: false });

export const ReadConfigurationValueCommandSchema = Type.Object({
  kind: Type.Literal("read-value"),
  path: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
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
  Type.Object({
    ok: Type.Literal(false),
    error: Type.Object({
      code: Type.Union([
        Type.Literal("invalid-command"),
        Type.Literal("repository-failure"),
        Type.Literal("invalid-repository-result"),
      ]),
      message: Type.String(),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
]);

export type JsonValue = Static<typeof JsonValueSchema>;
export type JsonObject = Static<typeof JsonObjectSchema>;
export type ConfigurationDocumentSnapshot = Static<typeof ConfigurationDocumentSnapshotSchema>;
export type ReadConfigurationValueCommand = Static<typeof ReadConfigurationValueCommandSchema>;
export type ReadConfigurationValueResult = Static<typeof ReadConfigurationValueResultSchema>;
