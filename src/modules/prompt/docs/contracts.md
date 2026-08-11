# Prompt contracts

## Public boundary

`public.ts` exports only serializable prompt assembly schemas, derived types, reader ports, and application entry points. It exposes prompt text as a result, not prompt fragments as mutable shared state.

## Planned schemas

- `AgentGuidanceRequest` and `AgentGuidanceResult`.
- `SubagentPromptRequest` and `SubagentPromptResult`.
- `PromptSourceSnapshot` for deterministic source provenance inside tests, not persisted runtime state.

Exact fields are defined by TypeBox in the prompt slices.

## Ports

The Parent guidance use case reads serialized catalogue and effective Model access projections through narrow reader ports connected by `bootstrap`. Filesystem context and custom prompt contents arrive as serialized strings.
