# pi-subagents-lite product requirements

This directory is the product-level requirements baseline for the `re` refactor. It describes user outcomes and supported workflows. It does not define source layout, module boundaries, TypeBox fields, or platform APIs.

## Status

Implemented. This PRD set is the active product baseline for the completed modular-monolith refactor on the `re` branch.

## Requirement ID scheme

Requirement IDs are stable and domain-oriented: `REQ-<DOMAIN>-<NUMBER>`. IDs remain stable when source modules are renamed or split. A requirement is active unless it is explicitly marked superseded in this directory.

## Documents

- [Agent calls and Agent catalogue](./agent-calls.md) — spawning, accepted policy, worktree targeting, and Agent type discovery.
- [Model access](./model-access.md) — Parent model, alternate models, Providers, scope, and Thinking access.
- [Runtime and lifecycle](./runtime.md) — queueing, concurrency, retention, stopping, and Child-session lifecycle.
- [Background results](./background-results.md) — durable result delivery and recovery.
- [Child screen](./child-screen.md) — the user-visible Child screen and Main/Child interaction.
- [Settings](./settings.md) — settings workflows and persistence failure behavior.

## Product-wide invariants

- The `Agent` tool remains the only spawn entry point.
- Accepted running and queued work keeps its accepted run policy; later settings affect only future calls.
- Existing user-visible behavior remains unchanged unless a requirement in this PRD explicitly states otherwise.
- Prompt material remains inspectable in the project source and documentation, but no prompt inspection menu, command, runtime viewer, log, or persisted prompt snapshot is added.
- External notification channels are out of scope.

## Scope exclusions

- No new provider installation or automatic model selection workflow.
- No second user-driven spawn flow.
- No persisted prompt transcript or prompt provenance feature.
- No database, daemon, remote service, or package-version change as part of the refactor.
