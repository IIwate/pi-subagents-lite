# Agent catalogue decisions

## Current

- Discovery and merge policy belong to one catalogue capability; frontmatter parsing remains an internal component.
- The effective definition is copied into the Accepted run policy at authorization time.
- Session-start discovery enters through `agent-catalogue/public.ts`; its filesystem source is wired by `bootstrap/agent-catalogue.ts`.
- The `disableDefaultAgents` value is validated as a catalogue-owned fragment and does not create a new persisted section.

## Superseded

- Historical discovery behavior is classified in [refactoring-history-audit.md](../../../../docs/refactoring-history-audit.md) until Phase 0 transfers each scenario to an owning test or decision.

## Implementation-only

- Existing source filenames and parser helper names are evidence, not a public contract.
- The legacy registry Map and on-demand Worktree discovery functions remain migration boundaries, not public catalogue contracts; Phase 2 removes them as their callers move.
