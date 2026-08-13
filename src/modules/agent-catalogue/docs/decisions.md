# Agent catalogue decisions

## Current

- Discovery and merge policy belong to one catalogue capability; frontmatter parsing remains an internal component.
- The effective definition is copied into the Accepted run policy at authorization time.
- Session-start and on-demand discovery enter through `agent-catalogue/public.ts`; the filesystem source is wired by `bootstrap/agent-catalogue.ts`.
- The `disableDefaultAgents` value is read through `configuration/public.ts`, then validated as a catalogue-owned fragment without creating a new persisted section.
- A malformed source file is rejected at the filesystem adapter boundary without hiding valid definitions from the same discovery request.
- Worktree-local definitions use project source attribution and only fill names absent from the built-in, global, and project merge.
- Tool, skill, and extension loading is resolved through `resolveAgentDefinitionPolicy`. The host supplies the fallback registered-tool list so the catalogue does not own Pi's built-in roster.

## Superseded

- Session-start `scanAndMerge` and on-demand `scanAgentFilesInDir`/`mergeAgents` execution are superseded by one catalogue facade. The in-process registry remains the runtime sink until its callers move.

## Implementation-only

- Existing source filenames and parser helper names are evidence, not a public contract.
- The legacy registry Map, `registerAgents`, and `resolveType` remain migration boundaries, not public catalogue contracts.
