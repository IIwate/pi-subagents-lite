# Architecture documentation

This directory is the system-level map for the S.U.P.E.R. modular monolith. It is not a second PRD and does not duplicate module contracts or decision rationale.

## Authorities

- [Architecture decisions](./decisions.md) owns cross-module decisions: module direction, serializable contracts, composition-root ownership, tool-registration rules, and their supersession history. The migration ADRs and the temporary history audit were consolidated into this file and the module decision documents, then retired.
- [Testing seams](./testing.md) owns the four public test seams and what tests may observe at each.
- Configuration source precedence is owned by the [configuration operations contract](../../src/modules/configuration/docs/operations.md).

## Module map

- [Agent catalogue](../../src/modules/agent-catalogue/docs/index.md)
- [Model access](../../src/modules/model-access/docs/index.md)
- [Subagent runtime](../../src/modules/subagent-runtime/docs/index.md)
- [Background result delivery](../../src/modules/background-result-delivery/docs/index.md)
- [Child screen](../../src/modules/child-screen/docs/index.md)
- [Settings](../../src/modules/settings/docs/index.md)
- [Prompt support](../../src/modules/prompt/docs/index.md)
- [Configuration support](../../src/modules/configuration/docs/index.md)

Module-specific rationale lives in each module's `docs/decisions.md`; `CONTEXT.md` remains a glossary and carries no architecture rationale.
