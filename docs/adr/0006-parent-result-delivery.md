# Session-local parent result delivery

## Status

Accepted.

## Decision

Background Agent completions are written to the parent Pi session as
session-local custom entries before the extension asks the parent to continue.
Each entry captures the parent session ID and the Agent call's origin entry.
The volatile `AgentManager` record remains a UI/execution record; the parent
session result entry is the recovery source after that record is cleaned.

Each retained terminal background Agent event is persisted and may request a
parent wake; concurrent wake requests are coalesced by the `SpawnCoordinator`.
The coordinator normalizes an otherwise empty terminal payload to `(no output)`
defensively; the runner's existing no-output failure classification is unchanged. Explicit Clear and runtime
teardown remove volatile work intentionally and do not create a new result
entry; results already persisted or staged for same-session handoff remain. An automatic wake directly
carries the current Auto pending set as one hidden `subagent-result` message;
a natural prompt injects pending results through `before_agent_start`. An Auto
result that completes after preflight is queued as a follow-up at `agent_start`
when no result delivery is already active. If the natural turn already carries
a result delivery, the Auto result starts a fresh turn after settlement instead.
A completion in the `agent_end` to `agent_settled` gap also waits for full
settlement and starts a fresh turn. This avoids treating both idle-looking gaps
as the same lifecycle state. A result is acknowledged only after the parent turn
carrying it settles successfully.
An exact `AgentStatus` read adds that result to the current parent turn's
presented IDs and follows the same successful-settlement acknowledgement rule.

The default background delivery mode is `Auto continue`. Every successfully
persisted Auto completion rechecks pending Auto results whose origin remains on
the active branch, so a later Auto completion may re-arm delivery for an older
eligible Auto result. A successfully persisted Auto completion that arrives
during a failed parent turn provides one new wake opportunity after that turn
settles; the failed result alone never retries itself automatically. Next-turn
completions never trigger or retry Auto delivery. Explicit session reload or
`/tree` navigation back to the origin subtree is a separate lifecycle recovery
event and re-arms eligible Auto delivery. Navigating away keeps unrelated
results silent. An automatic wake injects only eligible Auto results;
`Next natural turn` results remain pending until an eligible natural parent
prompt.

## Why

A result delivery call is fire-and-forget and does not acknowledge that the
parent provider accepted or consumed the content. Marking a record consumed at
call time can evict the only result after an auth, quota, or provider failure.
Persisting the final result first prevents that loss without adding another
database or restoring the child session.

Sending one parent message per completion can enqueue multiple follow-ups. If
the parent provider is unavailable, those messages become repeated failed
turns. Coalescing only the active wake request removes that self-inflicted
retry storm while allowing a later completion to request another wake after a
failed parent run.

## Boundaries

- Pending entries are stored across the current parent session file, but
  automatic delivery and UI state are local to the origin-entry subtree. Normal
  in-flight Auto delivery adds no pending UI text; `results pending` appears only
  after delivery is blocked or fails, while `results waiting for next turn` is
  the intentional Next-turn state.
- New and forked sessions ignore copied entries with a different parent session
  ID.
- They persist final result text and metadata, not prompts, full transcripts,
  or child-session state.
- An append failure has one process-local, parent-session-keyed handoff that
  survives Pi's Jiti module reload; process exit still drops that fallback.
- Pi exposes no global barrier before cross-extension `before_agent_start` or
  after all `session_start` handlers. Residual ordering windows are an accepted
  upstream lifecycle limitation; revisit after Pi adds a barrier or a production
  incident demonstrates material impact.
- There is no scheduler, join mode, unbounded retry, provider fallback, or
  external notification transport.
- A failed parent run does not immediately retry itself. A later completion,
  a natural parent turn, or an explicit result lookup provides the next
  recovery opportunity.
- The fixed 200ms nudge debounce is removed; result aggregation happens when
  the parent turn is prepared.
- Exact `AgentStatus({ agent_id })` lookup is an explicit session-wide read;
  its result is acknowledged only if that parent turn settles successfully.
  Implicit delivery never crosses into an unrelated branch.
- Foreground calls still return directly and are unaffected by background
  delivery mode.
