# Model access

## User outcomes

Users can explicitly authorize which Agent types may use the Parent model or alternate models from enabled Providers. The effective policy is visible consistently wherever it is used: authorization, runtime selection, settings, and Agent guidance.

## Requirements

### REQ-MODEL-001 — Parent model access

A fresh installation is Parent-only. Each Agent type can explicitly allow or deny access to the exact dynamic Parent model. Denial blocks implicit and explicit selection, including a saved alternate that currently becomes the Parent model.

### REQ-MODEL-002 — Alternate model authorization

An alternate model requires Model routing, explicit Provider access, the Agent type's Provider/model rule, Pi availability, explicit model selection, and Model scope. No missing or rejected choice silently falls back to another model.

### REQ-MODEL-003 — Provider and model rules

Users can authorize all current and future models from an enabled Provider or a selected exact-model set. Provider disablement and authentication loss keep saved rules reversible and dormant; they do not destructively clean them up.

### REQ-MODEL-004 — Scope

Models outside the active Model scope cannot be selected. A scope-pinned Thinking level is mandatory for that model without rewriting saved rules.

### REQ-MODEL-005 — Thinking access

Each authorized Agent type and exact model has an effective allowed/default Thinking rule. Without a saved override, Parent default use inherits the parent session's current Thinking when omitted; non-parent models use Pi's supported normalization of `high`.

### REQ-MODEL-006 — Guidance consistency

Before each eligible run, Agent guidance communicates the current effective access using exact callable model keys and the existing required-argument behavior. Guidance is not a user-facing prompt inspection capability.

### REQ-MODEL-007 — Atomic model setup

Quick model setup and the full settings workflow write the same canonical access state. A failed update leaves no partial Provider, routing, Agent, or Thinking change.

## Out of scope

- Provider installation, credential management, or automatic model selection.
- A global or Agent-type Thinking default that is not tied to an exact model policy.

## Acceptance intent

Acceptance examples cover the complete Parent/alternate decision table, availability and dormant states, scope exclusion, Thinking inheritance and overrides, quick setup atomicity, and guidance output.
