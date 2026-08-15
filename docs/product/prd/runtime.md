# Subagent runtime and lifecycle

## User outcomes

The parent LLM can start, stop, inspect, and interact with Subagents while concurrency, retention, cleanup, shutdown, and continuation remain predictable. A Child session can finish, fail, or be stopped without leaking resources or changing unrelated parent work.

## Requirements

### REQ-RUNTIME-001 — Hierarchical concurrency

Every run respects its model ceiling or fallback per-model ceiling and any shared Provider ceiling. Persisted finite values preserve scheduler capacity by clamping below-one values to 1 and rounding positive fractions up; values without numeric meaning still fall back or drop. New runs queue when a limit is full. Settled-session continuation reports a local concurrency block instead of silently queueing.

### REQ-RUNTIME-002 — Lifecycle states

Accepted work transitions through the existing queued, setup, running, settling, terminal, stopped, retained, and closed behavior. Each terminal outcome is observable through the existing tools and Child screen. The shared list order is attention, running, queued, archive; pins lead only inside their rank, terminal outcomes use newest completion first, and active rows preserve start/FIFO order.

### REQ-RUNTIME-003 — Foreground interruption

Foreground Agent calls follow the parent tool-call interrupt signal from before the asynchronous spawn boundary. Interrupting a parent turn stops setup or running foreground Agents and removes queued foreground Agents from execution while retaining stopped records. The platform setup cancellation surface exists before `session-ready`, so interruption cannot leak a first provider prompt. Background Agents remain detached.

### REQ-RUNTIME-004 — Retention and pinning

Persisted terminal Subagents are normally removed from the volatile list after the existing retention period. Session-local pinning pauses automatic cleanup and lifts the record only inside its existing status rank without blocking explicit removal. Unpinning restores the rank's time order and remaining cleanup time.

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

Acceptance examples cover concurrency normalization and ceilings, queueing/FIFO order, interruption throughout setup, setup failures, terminal recency, continuation repositioning, rank-local pinning, retention, shutdown races, late usage, and debug provenance.
