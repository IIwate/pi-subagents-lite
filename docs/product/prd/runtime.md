# Subagent runtime and lifecycle

## User outcomes

The parent LLM can start, stop, inspect, and interact with Subagents while concurrency, retention, cleanup, shutdown, and continuation remain predictable. A Child session can finish, fail, or be stopped without leaking resources or changing unrelated parent work.

## Requirements

### REQ-RUNTIME-001 — Hierarchical concurrency

Every run respects its model ceiling or fallback per-model ceiling and any shared Provider ceiling. New runs queue when a limit is full. Settled-session continuation reports a local concurrency block instead of silently queueing.

### REQ-RUNTIME-002 — Lifecycle states

Accepted work transitions through the existing queued, setup, running, settling, terminal, stopped, retained, and closed behavior. Each terminal outcome is observable through the existing tools and Child screen.

### REQ-RUNTIME-003 — Foreground interruption

Foreground Agent calls follow the parent tool-call interrupt signal. Interrupting a parent turn stops running foreground Agents and removes queued foreground Agents from execution while retaining stopped records. Background Agents remain detached.

### REQ-RUNTIME-004 — Retention and pinning

Persisted terminal Subagents are normally removed from the volatile list after the existing retention period. Session-local pinning pauses automatic cleanup without changing status ordering or blocking explicit removal.

### REQ-RUNTIME-005 — Failure and continuation

A failed Subagent is an ordinary `Error` terminal result and enters result delivery immediately. A still-settled live session may accept another prompt during ordinary retention; this is not persisted resume and is not exposed as a parent-LLM continuation tool.

### REQ-RUNTIME-006 — Shutdown safety

Shutdown is bounded and idempotent. Abort rejection, reentrant disposal, late usage, and late platform events do not corrupt serializable lifecycle state or unrelated sessions.

### REQ-RUNTIME-007 — Debug provenance

The existing session-local one-shot debug fault remains UI-only, is consumed only by the next Agent that starts, and is not persisted or exposed as lifecycle control to the parent LLM.

## Out of scope

- A new scheduler product setting beyond the existing settings workflow.
- A second runtime or daemon process.

## Acceptance intent

Acceptance examples cover concurrency ceilings, queueing, interruption, setup failures, terminal errors, continuation, retention, pinning, shutdown races, late usage, and debug provenance.
