# Agent catalogue testing

## Primary seam

Test catalogue application queries and snapshots through the module public surface. Do not call frontmatter helpers or inspect internal merge maps.

The first tracer example is linked to `REQ-CATALOGUE-002`: disabling built-in definitions still returns a same-name global definition through the public facade. The example validates the command and JSON-round-tripped result against their TypeBox schemas.

## Required scenarios

- Built-in and custom source precedence.
- Same-name custom definition preserved when a built-in definition is disabled.
- Worktree-only names are added; a worktree file does not replace a global or project definition of the same name.
- Malformed frontmatter rejected without hiding valid definitions.
- Tool, skill, and extension loading is resolved through the public policy command, including implicit defaults and a host-supplied fallback tool list.
- A repository failure produces a serializable failure result.

## Fixtures and doubles

Use an in-memory `AgentCatalogueRepository` for policy tests. Filesystem and source-loader doubles are allowed only at the repository contract seam. Expected snapshots are independent literals.

Filesystem parser tests cover the `platform/fs` adapter only. They are not a public catalogue policy seam.
