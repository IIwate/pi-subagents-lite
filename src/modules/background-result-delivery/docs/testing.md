# Background result delivery testing

## Primary seam

Test delivery state transitions through the public application surface using serialized commands and expected events.

## Required scenarios

- Persistence before one automatic wake.
- Active origin-branch eligibility and unrelated-branch hiding.
- Coalesced wake requests, failed parent turns, later completions, reload, and `/tree` restoration.
- Explicit AgentStatus acknowledgement only after successful parent settlement.
- Session-keyed fallback isolation and malformed-record handling.
- Repository append/read/acknowledge/atomic-failure contract behavior.

## Fixtures and doubles

Use in-memory result repositories and deterministic parent-lifecycle events. Mock only persistence and parent messaging ports; do not mock runtime or UI modules.
