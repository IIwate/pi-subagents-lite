# Agent catalogue testing

## Primary seam

Test catalogue application queries and snapshots through the module public surface. Do not call frontmatter helpers or inspect internal merge maps.

## Required scenarios

- Built-in and custom source precedence.
- Same-name custom definition preserved when a built-in definition is disabled.
- Malformed frontmatter rejected without hiding valid definitions.
- Tool, skill, extension, system-prompt, model, and runtime settings are resolved into an immutable snapshot.
- A repository failure produces a serializable failure result.

## Fixtures and doubles

Use an in-memory `AgentCatalogueRepository` for policy tests. Filesystem and source-loader doubles are allowed only at the repository contract seam. Expected snapshots are independent literals.
