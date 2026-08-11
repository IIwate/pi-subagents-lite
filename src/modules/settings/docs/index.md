# Settings module

## Responsibility

Compose renderer-independent settings workflows and delegate each policy update to its owning module.

## Non-responsibilities

- It does not own Model, runtime, prompt, catalogue, display, or delivery policy.
- It does not persist configuration directly.
- It does not construct Pi menus or retain TUI components.

## Product requirements

- [Settings PRD](../../../../docs/product/prd/settings.md)

Owned requirement IDs: `REQ-SETTINGS-001`, `REQ-SETTINGS-002`, `REQ-SETTINGS-003`, `REQ-SETTINGS-005`, and `REQ-CONFIG-001`.

## Domain terms

Use [CONTEXT.md](../../../../CONTEXT.md) for Model access, Thinking access, concurrency, Child screen, and Accepted run policy.

## Document map

- [contracts.md](./contracts.md) — settings commands, snapshots, and action results.
- [ui-states.md](./ui-states.md) — renderer-independent settings matrix.
- [testing.md](./testing.md) — workflow and persistence seams.
- [decisions.md](./decisions.md) — settings ownership history.
