# Subagent runtime module

## Responsibility

Accept authorized Agent runs and own the ephemeral Subagent lifecycle from queueing through settlement, interaction, retention, and close.

## Non-responsibilities

- It does not define Agent types or Model authorization.
- It does not own durable background result eligibility.
- It does not render the Child screen or settings.
- It does not hold Pi session handles in application state.

## Product requirements

- [Agent calls](../../../../docs/product/prd/agent-calls.md)
- [Runtime and lifecycle](../../../../docs/product/prd/runtime.md)

Owned requirement IDs: `REQ-AGENT-001`, `REQ-AGENT-002`, `REQ-AGENT-003`, `REQ-WORKTREE-001`, `REQ-RUNTIME-001`, `REQ-RUNTIME-002`, `REQ-RUNTIME-003`, `REQ-RUNTIME-004`, `REQ-RUNTIME-005`, `REQ-RUNTIME-006`, and `REQ-RUNTIME-007`.

## Domain terms

Use [CONTEXT.md](../../../../CONTEXT.md) for Subagent, Accepted run policy, Child screen, Grace turns, and Worktree.

## Document map

- [contracts.md](./contracts.md) — lifecycle commands, snapshots, and session port.
- [state-machine.md](./state-machine.md) — lifecycle transitions and time semantics.
- [testing.md](./testing.md) — lifecycle seams and contract fixtures.
- [decisions.md](./decisions.md) — runtime ownership history.
