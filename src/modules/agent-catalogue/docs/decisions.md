# Agent catalogue decisions

## Current

- Discovery and merge policy belong to one catalogue capability; frontmatter parsing remains an internal component.
- The effective definition is copied into the Accepted run policy at authorization time.
- Session-start and on-demand discovery enter through `agent-catalogue/public.ts`; the filesystem source is wired by `bootstrap/agent-catalogue.ts`.
- The `disableDefaultAgents` value is read through `configuration/public.ts`, then validated as a catalogue-owned fragment without creating a new persisted section.
- A malformed source file is rejected at the filesystem adapter boundary without hiding valid definitions from the same discovery request.
- Worktree-local definitions use project source attribution and only fill names absent from the built-in, global, and project merge.
- Project trust stays outside the module: bootstrap reads `ctx.isProjectTrusted()` and expresses the verdict as the absence of the project (and worktree) root in the discover command. The catalogue never queries the host context and cannot distinguish "untrusted" from "no project root configured" — see [Project resource trust](../../../../docs/architecture/decisions.md#project-resource-trust).
- Tool, skill, and extension loading is resolved through `resolveAgentDefinitionPolicy`. The host supplies the fallback registered-tool list so the catalogue does not own Pi's built-in roster.
- A Subagent never inherits the Agent tool, so it cannot spawn a Subagent of its own. The exclusion is applied while resolving the effective tool policy rather than at spawn time, because a definition that names the tool explicitly must also be denied. Recursive spawning has no bounded depth, no aggregate concurrency accounting, and no delivery path back to the human, so the ceiling is absent rather than configurable. `excludeInheritedTools` is the catalogue-owned rule and is exported from `public.ts`; the Pi adapter consumes that function and must not keep a second list.
- Type name resolution (REQ-AGENT-004) is the catalogue-owned pure function `resolveAgentTypeName`: exact canonical > unique case-folded canonical > unique display-name alias; collisions return `ambiguous` with deduplicated, code-unit-sorted canonical candidates rather than Map insertion order. Canonical matching completes before display names, so an alias never shadows a canonical name. Code-unit sort (not locale collation) keeps candidate lists byte-stable across platforms. The Agent tool performs one authorized rescan for any non-exact outcome so a freshly added exact name wins the second, final resolution.

## Superseded

- Session-start `scanAndMerge`, on-demand `mergeAgents`, and `src/agents/agent-discovery.ts` are superseded by the catalogue facade plus `platform/fs` frontmatter scanning. The in-process registry lives in `bootstrap` as the activation-scoped sink.

## Implementation-only

- Existing source filenames and parser helper names are evidence, not a public contract.
- Frontmatter scanning lives in `platform/fs`. The legacy registry Map and `registerAgents` remain migration boundaries, not public catalogue contracts. The registry's `resolveType` now delegates its semantics to `resolveAgentTypeName` and only supplies the entries snapshot; migrating the remaining lookup commands into the catalogue capability is still a future slice, so the boundary is narrowed, not gone.
