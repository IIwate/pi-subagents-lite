# Agent catalogue module

## Responsibility

Discover, merge, normalize, and expose serializable Agent type definitions for future calls.

## Non-responsibilities

- It does not authorize a model call; `model-access` owns that policy.
- It does not create Pi sessions or schedule work.
- It does not render menus or assemble extension-controlled prompt text.
- It does not persist a runtime handle.

## Product requirements

- [REQ-CATALOGUE-001](../../../../docs/product/prd/agent-calls.md#req-catalogue-001)
- [REQ-CATALOGUE-002](../../../../docs/product/prd/agent-calls.md#req-catalogue-002)

These are the only product requirements owned by this module. Agent call and runtime requirements belong to `subagent-runtime`.

## Domain terms

Use [CONTEXT.md](../../../../CONTEXT.md) for Agent type, Accepted run policy, Worktree, and related terms.

## Document map

- [contracts.md](./contracts.md) — public schemas and ports.
- [testing.md](./testing.md) — public seams and catalogue fixtures.
- [decisions.md](./decisions.md) — current and historical ownership decisions.
