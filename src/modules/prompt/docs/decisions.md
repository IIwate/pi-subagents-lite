# Prompt support decisions

## Current

- Agent guidance and Subagent system prompt are distinct outputs with one source owner.
- Prompt assembly is deterministic and receives explicit snapshots; it has no global refresh or persistence.
- Prompt material is inspectable in source and module documentation, not through a new product capability.
- Parent Agent guidance is assembled through `prompt/public.ts`. Bootstrap wires the catalogue reader port and translates Pi models and scope.
- Custom prompt and context-file bytes are read in `platform/fs` and enter prompt assembly as strings.

## Superseded

- Consumer-owned prompt fragments and independently projected Model access guidance are retired. The [prompt source inventory](./prompt-sources.md) owns every extension-controlled fragment and its ordering.

## Implementation-only

- Existing helper names, prompt file locations, and Pi callback closures are not public prompt concepts.
