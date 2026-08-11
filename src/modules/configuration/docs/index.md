# Configuration support module

## Responsibility

Resolve external configuration sources and atomically transact serialized fragments owned by other modules.

## Non-responsibilities

- It does not define product defaults or policy.
- It does not render settings or synchronize runtime/UI objects.
- It does not change the persisted JSON shape during this refactor.

## Supported product requirements

- [REQ-CONFIG-001](../../../../docs/product/prd/settings.md#req-config-001)
- [Settings PRD](../../../../docs/product/prd/settings.md)

`REQ-CONFIG-001` is the only persistence behavior correction owned by this support module. All other settings requirements remain owned by `settings` or the policy module they delegate to.

## Domain terms

Use [CONTEXT.md](../../../../CONTEXT.md) for configuration-related product terms. Configuration source precedence is an operational rule, not a domain term.

## Document map

- [contracts.md](./contracts.md) — document snapshots and transaction port.
- [operations.md](./operations.md) — source precedence and failure boundaries.
- [testing.md](./testing.md) — repository contract tests.
- [decisions.md](./decisions.md) — configuration ownership history.
