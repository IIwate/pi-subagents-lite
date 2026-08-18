# Background result delivery testing

## Primary seam

Test delivery state transitions through the public application surface using serialized commands and expected events.

## Required scenarios

- Persistence before one automatic wake. Each injected wake body is clipped to 4000 characters; persist and AgentStatus keep the full text.
- Active origin-branch eligibility and unrelated-branch hiding.
- Coalesced wake requests, failed parent turns, later completions, reload, and `/tree` restoration.
- Explicit AgentStatus acknowledgement only after successful parent settlement.
- Guidance failure before preflight leaves repository state unacknowledged; the next successful handler returns result message and guidance together. A non-Agent run still injects pending results without reading the guidance catalogue.
- An explicit inspect rereads records written after delivery construction, prefers a later durable continuation over an old memory view, and honors an exact delivery ID and durable equal-time tie break.
- A durable-only exact inspect hydrates presentation tracking so successful settlement acknowledges it; foreign-session exact inspect is absent and cannot be acknowledged; `record-terminal` rejects queued/running statuses.
- Session-keyed fallback isolation, malformed-record handling, and off-contract records dropped on the way in.
- Outbound `execute()` results that fail `DeliveryCommandResultSchema` are refused as `invalid-command` rather than handed out.

## Fixtures and doubles

Use in-memory result repositories and deterministic parent-lifecycle events. Mock only persistence and parent messaging ports; do not mock runtime or UI modules.

The repository append/read/find/acknowledge/atomic-failure contract is proven against the real Pi adapter in `test/platform/result-repository.test.ts`. A suite that exercised an in-memory repository written inside the same test file was removed: it asserted on its own fake, so it passed no matter what the port or its adapter did.
