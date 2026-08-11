# Architecture documentation

This directory is the system-level map for the S.U.P.E.R. modular monolith. It is not a second PRD and does not duplicate module contracts or decision rationale.

## During migration

- [S.U.P.E.R. boundaries ADR](../adr/0009-super-architecture-boundaries.md) is the migration-time authority for module direction, serializable contracts, composition-root wiring, and replacement rules.
- [Refactoring plan](../refactoring-plan.md) owns evidence, phases, gates, and delivery cadence.
- [History audit](../refactoring-history-audit.md) is temporary planning evidence only. It is transferred into the owning documents and retired in Phase 9.

## Module map

- [Agent catalogue](../../src/modules/agent-catalogue/docs/index.md)
- [Model access](../../src/modules/model-access/docs/index.md)
- [Subagent runtime](../../src/modules/subagent-runtime/docs/index.md)
- [Background result delivery](../../src/modules/background-result-delivery/docs/index.md)
- [Child screen](../../src/modules/child-screen/docs/index.md)
- [Settings](../../src/modules/settings/docs/index.md)
- [Prompt support](../../src/modules/prompt/docs/index.md)
- [Configuration support](../../src/modules/configuration/docs/index.md)

## Final ownership

After the refactor, cross-module decisions will be consolidated into `docs/architecture/decisions.md`. That file is intentionally not created as a competing authority before the migration ADR content and its rationale can be transferred in one reviewed step.
