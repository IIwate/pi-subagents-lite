# Model access module

## Responsibility

Decide effective Parent model, alternate model, Provider, scope, and Thinking authorization for an Agent type.

## Non-responsibilities

- It does not install Providers or authenticate credentials.
- It does not start sessions, queue work, or render settings.
- It does not compose Agent guidance or Subagent system prompts.

## Product requirements

- [Model access PRD](../../../../docs/product/prd/model-access.md)

Owned requirement IDs: `REQ-MODEL-001`, `REQ-MODEL-002`, `REQ-MODEL-003`, `REQ-MODEL-004`, `REQ-MODEL-005`, `REQ-MODEL-006`, and `REQ-MODEL-007`.

## Domain terms

Use [CONTEXT.md](../../../../CONTEXT.md) for Model access, Parent model access, Provider access, Model scope, Thinking access, Dormant provider rules, and Unavailable model rules.

## Document map

- [contracts.md](./contracts.md) — public policy snapshots and commands.
- [decision-tables.md](./decision-tables.md) — authorization and Thinking combinations.
- [testing.md](./testing.md) — policy seams and examples.
- [decisions.md](./decisions.md) — policy ownership history.
