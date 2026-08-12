import { Type, type Static } from "typebox";

const StringArraySchema = Type.Array(Type.String());
const SelectionSchema = Type.Union([Type.Boolean(), StringArraySchema]);

export const AgentDefinitionSourceSchema = Type.Union([
  Type.Literal("built-in"),
  Type.Literal("global"),
  Type.Literal("project"),
]);

export const AgentDefinitionSnapshotSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  displayName: Type.Optional(Type.String()),
  description: Type.String(),
  registeredTools: Type.Optional(StringArraySchema),
  tools: Type.Optional(SelectionSchema),
  excludeTools: Type.Optional(StringArraySchema),
  extensions: Type.Optional(SelectionSchema),
  excludeExtensions: Type.Optional(StringArraySchema),
  skills: Type.Optional(SelectionSchema),
  preloadSkills: Type.Optional(Type.Union([Type.Literal(false), StringArraySchema])),
  maxTurns: Type.Optional(Type.Number()),
  maxTokens: Type.Optional(Type.Number()),
  systemPrompt: Type.String(),
  hidden: Type.Optional(Type.Boolean()),
  source: Type.Optional(AgentDefinitionSourceSchema),
}, { additionalProperties: false });

export const AgentSourceDefinitionSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  displayName: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  registeredTools: Type.Optional(StringArraySchema),
  tools: Type.Optional(SelectionSchema),
  excludeTools: Type.Optional(StringArraySchema),
  extensions: Type.Optional(SelectionSchema),
  excludeExtensions: Type.Optional(StringArraySchema),
  skills: Type.Optional(SelectionSchema),
  preloadSkills: Type.Optional(Type.Union([Type.Literal(false), StringArraySchema])),
  maxTurns: Type.Optional(Type.Number()),
  maxTokens: Type.Optional(Type.Number()),
  systemPrompt: Type.String(),
  hidden: Type.Optional(Type.Boolean()),
  source: Type.Union([Type.Literal("global"), Type.Literal("project")]),
}, { additionalProperties: false });

export const AgentCatalogueConfigurationSchema = Type.Object({
  disableDefaultAgents: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const AgentCatalogueRootsSchema = Type.Object({
  globalDirectory: Type.String(),
  projectDirectory: Type.String(),
}, { additionalProperties: false });

export const AgentSourceLoadRequestSchema = AgentCatalogueRootsSchema;

export const AgentSourceLoadResultSchema = Type.Object({
  definitions: Type.Array(AgentSourceDefinitionSchema),
}, { additionalProperties: false });

export const DiscoverAgentCatalogueCommandSchema = Type.Object({
  kind: Type.Literal("discover"),
  roots: AgentCatalogueRootsSchema,
  configuration: AgentCatalogueConfigurationSchema,
}, { additionalProperties: false });

export const AgentCatalogueSnapshotSchema = Type.Object({
  definitions: Type.Array(AgentDefinitionSnapshotSchema),
}, { additionalProperties: false });

export const AgentCatalogueResultSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    catalogue: AgentCatalogueSnapshotSchema,
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

export type AgentDefinitionSnapshot = Static<typeof AgentDefinitionSnapshotSchema>;
export type AgentSourceDefinition = Static<typeof AgentSourceLoadResultSchema>["definitions"][number];
export type AgentCatalogueConfiguration = Static<typeof AgentCatalogueConfigurationSchema>;
export type AgentSourceLoadRequest = Static<typeof AgentSourceLoadRequestSchema>;
export type AgentSourceLoadResult = Static<typeof AgentSourceLoadResultSchema>;
export type DiscoverAgentCatalogueCommand = Static<typeof DiscoverAgentCatalogueCommandSchema>;
export type AgentCatalogueSnapshot = Static<typeof AgentCatalogueSnapshotSchema>;
export type AgentCatalogueResult = Static<typeof AgentCatalogueResultSchema>;
