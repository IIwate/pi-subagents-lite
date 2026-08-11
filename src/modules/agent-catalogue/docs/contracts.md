# Agent catalogue contracts

## Public boundary

The module exposes one `public.ts` surface. Cross-module values are JSON-serializable and validated at the receiving boundary.

## Planned schemas

- `AgentDefinitionSnapshot` — one effective Agent type definition.
- `AgentCatalogueSnapshot` — the ordered set of available definitions and source metadata.
- `CatalogueQuery` and `CatalogueResult` — discovery and lookup requests/results.
- `CatalogueChanged` — a serializable snapshot replacement notification when a host lifecycle requires one.

Exact fields are owned by the TypeBox schemas introduced in the relevant vertical slice. This document does not duplicate field lists.

## Port

`AgentCatalogueRepository` loads serialized source definitions from configured roots. It does not expose frontmatter parser objects or filesystem handles.

## Dependency rule

`contracts` and `core` do not import Pi, Node filesystem APIs, process globals, timers, or other module internals. Consumers import only `public.ts`.
