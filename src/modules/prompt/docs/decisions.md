# Prompt support decisions

## Current

- Agent guidance and Subagent system prompt are distinct outputs with one source owner.
- Prompt assembly is deterministic and receives explicit snapshots; it has no global refresh or persistence.
- Prompt material is inspectable in source and module documentation, not through a new product capability.

## Superseded

- Prompt fragments previously assembled in `events.ts` and `agent-runner` are historical ownership evidence in [refactoring-history-audit.md](../../../../docs/refactoring-history-audit.md).

## Implementation-only

- Existing helper names, prompt file locations, and Pi callback closures are not public prompt concepts.
