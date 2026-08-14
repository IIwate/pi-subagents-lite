# Prompt support module

## Responsibility

Deterministically assemble extension-controlled Agent guidance and Subagent system prompts from explicit serializable inputs.

## Non-responsibilities

- It does not expose prompt inspection as a user-facing capability.
- It does not add menus, commands, runtime viewers, logs, or persistence.
- It does not read Pi context or configuration storage directly.
- It does not own Agent definitions, Model access policy, or Subagent lifecycle.

## Supported product requirements

- [REQ-MODEL-006](../../../../docs/product/prd/model-access.md#req-model-006--guidance-consistency)
- [REQ-AGENT-001](../../../../docs/product/prd/agent-calls.md#req-agent-001--spawn-through-agent)

These are supported requirements, not prompt-owned product capabilities. Their owning modules remain `model-access` and `subagent-runtime`.

## Domain terms

Use [CONTEXT.md](../../../../CONTEXT.md) for Agent guidance and Subagent system prompt. Do not use “injected prompt” as a product term.

## Document map

- [contracts.md](./contracts.md) — prompt assembly requests and results.
- [prompt-sources.md](./prompt-sources.md) — source ownership and ordering.
- [testing.md](./testing.md) — deterministic assembly tests.
- [decisions.md](./decisions.md) — prompt ownership history.
