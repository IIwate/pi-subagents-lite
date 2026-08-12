# Agent catalogue decisions

## Current

- Discovery and merge policy belong to one catalogue capability; frontmatter parsing remains an internal component.
- The effective definition is copied into the Accepted run policy at authorization time.
- Session-start discovery enters through `agent-catalogue/public.ts`; its filesystem source is wired by `bootstrap/agent-catalogue.ts`.
- The `disableDefaultAgents` value is read through `configuration/public.ts`, then validated as a catalogue-owned fragment without creating a new persisted section.
- A malformed source file is rejected at the filesystem adapter boundary without hiding valid definitions from the same discovery request.

## Superseded

- Discovery spread across session-start and registry helpers is superseded by one catalogue facade. Phase 2 removes the remaining on-demand registry path when its caller moves.

## Implementation-only

- Existing source filenames and parser helper names are evidence, not a public contract.
- The legacy registry Map and on-demand Worktree discovery functions remain migration boundaries, not public catalogue contracts; Phase 2 removes them as their callers move.
