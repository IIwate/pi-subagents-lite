# Agent catalogue contracts

## Public boundary

The module exposes one `public.ts` surface. Cross-module values are JSON-serializable and validated at the receiving boundary.

## Implemented schemas

- `AgentDefinitionSnapshotSchema` defines one effective Agent type definition and its source.
- `AgentCatalogueSnapshotSchema` defines the ordered effective definitions.
- `DiscoverAgentCatalogueCommandSchema` defines source roots and the catalogue-owned configuration fragment for discovery. `projectDirectory` and `worktreeDirectory` are optional, and each present root is a non-empty string: an untrusted session's bootstrap simply does not construct them (REQ-CATALOGUE-003), so the module and its repository never receive the paths and hold no trust concept of their own. The repository returns empty sources for absent roots.
- `AgentCatalogueResultSchema` defines success and serializable validation or repository failures.
- `AgentSourceLoadRequestSchema` and `AgentSourceLoadResultSchema` define the filesystem repository boundary. Worktree files arrive in `worktreeDefinitions` so merge can keep them additive.
- `ResolveAgentPolicyCommandSchema` and `ResolvedAgentLoadingPolicySchema` resolve tool, skill, and extension loading for one definition. Implicit defaults and the host's fallback registered-tool list arrive as command configuration.
- `excludeInheritedTools` removes tool names a Subagent must not inherit. Policy resolve applies it to registered and allowlisted tools.
- `AgentTypeResolutionSchema` and `ResolveAgentTypeNameQuerySchema` define the deterministic type-name resolution boundary (REQ-AGENT-004). `resolveAgentTypeName` checks the query and its own result and throws `TypeError` on either violation.
- `AgentDefinitionSnapshotSchema` is also consumed by the runtime's `AcceptedRunPolicySchema` through the catalogue public surface.

Exact fields are owned by the TypeBox schemas introduced in the relevant vertical slice. This document does not duplicate field lists.

Lookup commands and catalogue-change notifications remain planned for the slices that migrate their current production call sites.

## Port

`AgentCatalogueRepository` loads serialized global and project source definitions from configured roots. It does not expose frontmatter parser objects or filesystem handles. The Node filesystem implementation is isolated under `platform/fs` and is selected by the bootstrap factory.

The filesystem adapter validates each mapped definition before it enters the repository result. One malformed file is isolated; the application still validates the complete repository result so a defective replacement adapter cannot cross the module boundary.

## Dependency rule

`contracts` and `core` do not import Pi, Node filesystem APIs, process globals, timers, or other module internals. Consumers import only `public.ts`.
