# Background result delivery decisions

## Current

- Delivery policy is separate from result persistence and parent wake mechanics.
- Every terminal background completion, including `error`, is persisted to the parent Pi session before any wake is requested. A wake call is fire-and-forget and cannot confirm that the parent provider accepted the content, so marking a record consumed at call time could evict the only copy of a result after an auth, quota, or provider failure. Persisting first prevents that loss without another database or a restored child session.
- Concurrent wake requests are coalesced. One parent message per completion would enqueue multiple follow-ups, and an unavailable parent provider would turn them into repeated failed turns; coalescing removes that self-inflicted retry storm while a later completion may still request a new wake after a failed parent run.
- A failed automatic wake does not retry itself; a later eligible event — another completion, a natural parent prompt, an explicit exact read — provides the next opportunity. A result is acknowledged only after the parent turn carrying it settles successfully; an exact `AgentStatus({ agent_id })` read is session-wide and follows the same settlement rule.
- Persisted entries carry final result text and metadata only — no prompts, transcripts, or child-session state — and forked or new sessions ignore copied entries with a different parent session ID.
- A result is eligible only while its origin entry is on the active branch. The branch set is read from the host at turn and navigation boundaries, and a background spawn registers its own origin entry through `track-origin` at call time: the entry carrying the Agent call is born inside the turn, so a purely boundary-driven set would classify the run's own origin as off-branch and hide the result the caller is waiting for. The seed is deliberately discarded by the next refresh — by then the host reports the entry itself, or the user navigated to another branch where hiding is correct.
- An append failure is staged in the process-local fallback inbox keyed by parent session ID (`platform/process/process-state.ts`); one session's bucket never exposes or overwrites another's. The handoff survives Pi's Jiti reload; process exit drops all buckets.
- Pi exposes no ordering barrier before cross-extension `before_agent_start` or after all `session_start` handlers. The residual ordering windows are an accepted upstream limitation; revisit if Pi adds a barrier or an incident demonstrates material impact.
- There is no scheduler, join mode, unbounded retry, provider fallback, or external notification transport. Child provider, quota, authentication, content-filter, and exhausted transport-retry failures are ordinary one-shot `error` results; Pi's own transient retry loop is unchanged.

## Superseded

- Configurable next-turn delivery and session-global injection are retired. Durable origin-branch eligibility and the state-machine examples are the current authority.
- The fixed 200ms wake debounce is retired; result aggregation happens when the parent turn is prepared.

## Implementation-only

- Result-inbox helper names, debounce constants, and manager refresh calls are not delivery concepts. Bootstrap translates Pi lifecycle into delivery commands; spawn and delivery stay separate functions.
