# Background result delivery module

## Responsibility

Decide when a terminal background result is eligible, presented, acknowledged, failed, or restored for a parent session.

## Non-responsibilities

- It does not run Subagents or decide their lifecycle.
- It does not own filesystem persistence or Pi parent wake mechanics.
- It does not render pending counts or Child screen rows.

## Product requirements

- [Background results PRD](../../../../docs/product/prd/background-results.md)

Owned requirement IDs: `REQ-DELIVERY-001`, `REQ-DELIVERY-002`, `REQ-DELIVERY-003`, `REQ-DELIVERY-004`, and `REQ-DELIVERY-005`.

## Domain terms

Use [CONTEXT.md](../../../../CONTEXT.md) for Background result delivery, active branch, restoration, acknowledgement, and retained terminal Subagents.

## Document map

- [contracts.md](./contracts.md) — delivery commands, events, and snapshots.
- [state-machine.md](./state-machine.md) — delivery transitions.
- [testing.md](./testing.md) — delivery and repository seams.
- [decisions.md](./decisions.md) — delivery ownership history.
