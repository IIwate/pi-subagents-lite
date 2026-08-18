# Prompt contracts

## Public boundary

`public.ts` exports only serializable prompt assembly schemas, derived types, reader ports, and application entry points. It exposes prompt text as a result, not prompt fragments as mutable shared state.

## Implemented schemas

- `AgentGuidanceRequestSchema` and `AgentGuidanceResultSchema` assemble Parent Agent guidance from serializable catalogue and Model access inputs.
- `SubagentPromptRequestSchema` and `SubagentPromptResultSchema` assemble the Subagent system prompt from serializable fragments.

Context paths and active Agent names are serialized as XML attribute values by the prompt renderer, including `&`, `<`, `>`, and `"` encoding; the schemas intentionally continue to accept arbitrary non-empty strings.

## Planned schemas
- `PromptSourceSnapshot` for deterministic source provenance inside tests, not persisted runtime state.

Exact fields are defined by TypeBox in the prompt slices.

## Ports

`PromptCatalogueReader` supplies the current Agent type list. Bootstrap connects it to the session catalogue snapshot. Custom prompt and context-file contents arrive as serialized strings from `platform/fs`.
