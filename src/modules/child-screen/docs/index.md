# Child screen module

## Responsibility

Own renderer-independent Child screen navigation, selection, folding, notices, and presentation snapshots.

## Non-responsibilities

- It does not mutate Pi components or private layout objects.
- It does not change Subagent lifecycle or delivery policy.
- It does not decide Model access or settings policy.

## Product requirements

- [Child screen PRD](../../../../docs/product/prd/child-screen.md)

Owned requirement IDs: `REQ-CHILD-001`, `REQ-CHILD-002`, `REQ-CHILD-003`, and `REQ-CHILD-004`.

## Domain terms

Use [CONTEXT.md](../../../../CONTEXT.md) for Child screen, Main, expanded/folded state, and local-only interaction failure.

## Document map

- [contracts.md](./contracts.md) — navigation commands and snapshots.
- [ui-states.md](./ui-states.md) — renderer-independent state matrix.
- [testing.md](./testing.md) — navigation and renderer seams.
- [decisions.md](./decisions.md) — Child screen ownership history.
