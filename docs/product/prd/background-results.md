# Background result delivery

## User outcomes

When a background Subagent completes or errors, its result is delivered to the parent session under the existing branch and lifecycle rules. Results remain recoverable after a failed wake, reload, or explicit navigation without leaking unrelated branch data.

## Requirements

### REQ-DELIVERY-001 — Durable terminal result

A terminal background result is persisted with its parent session and Agent-call origin before its automatic wake opportunity.

### REQ-DELIVERY-002 — Origin-branch eligibility

Automatic delivery is eligible only while the origin entry remains on the active branch. Results from unrelated branches stay hidden until the existing explicit restoration event makes them eligible.

### REQ-DELIVERY-003 — Failed wake recovery

Concurrent wake requests are coalesced. A completion persisted during a failed parent turn provides one later wake opportunity after settlement; the failed delivery itself does not retry indefinitely.

### REQ-DELIVERY-004 — Explicit reads and acknowledgement

The next natural parent prompt injects eligible pending results during preflight. Explicit AgentStatus reads acknowledge results only after the parent turn settles successfully.

### REQ-DELIVERY-005 — Session isolation

Reloaded or forked sessions ignore copied result entries whose parent session ID does not match. Fallback buckets are isolated by parent session ID.

## Out of scope

- Webhooks, Telegram, email, or other external notification channels.
- Prompt, transcript, source-code, or findings disclosure through notifications by default.

## Acceptance intent

Acceptance examples cover persistence, branch changes, failed wakes, later completions, reload, `/tree`, explicit reads, acknowledgement, malformed records, and repository failure.
