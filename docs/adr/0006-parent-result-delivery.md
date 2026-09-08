# Session-local parent result delivery

## Status

Accepted.

## Decision

Background Agent completions are written to the parent Pi session as
session-local custom entries before the extension asks the parent to continue.
Each entry captures the parent session ID and the Agent call's origin entry.
The volatile `AgentManager` record remains a UI/execution record; the parent
session result entry remains the durable source after that record is cleaned.

Every terminal background Agent event, including `error`, is persisted and may request a
parent wake; concurrent wake requests are coalesced by the `SpawnCoordinator`.
The coordinator normalizes an otherwise empty terminal payload to `(no output)`
defensively; the runner's existing no-output failure classification is unchanged. Explicit Clear and runtime
teardown remove volatile work intentionally and do not create a new result
entry; results already persisted or staged for same-session handoff remain. An automatic wake directly
carries the current eligible pending set as one hidden `subagent-result` message;
a natural prompt injects pending results through `before_agent_start`. A
result that completes after preflight is queued as a follow-up at `agent_start`
when no result delivery is already active. If the natural turn already carries
a result delivery, the new result starts a fresh turn after settlement instead.
A completion in the `agent_end` to `agent_settled` gap also waits for full
settlement and starts a fresh turn. This avoids treating both idle-looking gaps
as the same lifecycle state. A result is acknowledged (`result-ack`) once the hidden
`subagent-result` delivery message or the exact `AgentStatus` tool result entry is
durably persisted in the parent session log. The ACK contract confirms that the
parent session has durably ingested the completion into its persistent context;
whether the subsequent LLM model turn succeeds, errors, or is aborted does not gate
ACK persistence. Session recovery reconciles durable delivery receipts from disk and
automatically appends missing ACKs without re-injecting duplicate results into context.
Natural prompt preparation and lifecycle restoration await receipt reconciliation
before selecting results for delivery. Receipt metadata identifies the parent
session and exact completion IDs; only hidden `subagent-result` messages and
successful `AgentStatus` tool results carrying content qualify. Explicit lookup
tracking suppresses concurrent sends while the tool result is in flight, and does
not establish durable receipt.

The delivery policy is automatic. Every successfully persisted
completion rechecks pending results whose origin remains on the active branch,
so a later completion may re-arm delivery for older eligible results. A
completion persisted during a failed parent turn provides one new wake
opportunity after that turn settles; the failed result alone never retries
itself automatically. Explicit session reload or `/tree` navigation back to
the origin subtree is a separate restoration event and re-arms eligible
delivery. Navigating away keeps unrelated results silent. The next natural
parent prompt injects eligible pending results during preflight, including
after an automatic wake failed.

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
  in-flight delivery adds no pending UI text; `results pending` appears only
  after delivery is blocked or fails.
- New and forked sessions ignore copied entries with a different parent session
  ID.
- Receipt reconciliation reads the current session file and verifies its header
  and complete JSONL records. An unavailable file or incomplete final line leaves
  results unacknowledged. Each asynchronous read is bound to its coordinator,
  parent session ID, and session file; stale reads cannot acknowledge another
  session. Completions persisted during a read remain pending and request a fresh
  snapshot. Missing ACKs are retried independently of result delivery.
- They persist final result text and metadata, not prompts, full transcripts,
  or child-session state.
- An append failure is kept in a process-local Map keyed by parent session ID.
  Setting or consuming one session never overwrites, exposes, or deletes another
  session's bucket. The handoff survives Pi's Jiti module reload; process exit
  still drops all buckets.
- Pi exposes no global barrier before cross-extension `before_agent_start` or
  after all `session_start` handlers. Residual ordering windows are an accepted
  upstream lifecycle limitation; revisit after Pi adds a barrier or a production
  incident demonstrates material impact.
- There is no scheduler, join mode, unbounded retry, provider fallback, or
  external notification transport.
- A failed parent run does not immediately retry itself. A later completion,
  a natural parent turn, or an explicit result lookup provides the next
  delivery opportunity.
- Result aggregation happens when the parent turn is prepared.
- Exact `AgentStatus({ agent_id })` lookup is an explicit session-wide read;
  its result carries delivery receipt metadata and is acknowledged once persisted
  in the session log. Implicit delivery never crosses into an unrelated branch.
- Foreground calls still return directly and are unaffected by background
  result persistence. When an interrupted or settled foreground agent is
  continued manually via the child view, it is promoted to inbox delivery so
  its continuation results reach the parent session.
- Child provider, quota, authentication, content-filter, configuration, and
  exhausted transport-retry failures are ordinary one-shot `error` results.
  The extension does not spawn replacements or add another retry timer. Pi's
  own transient transport retry loop remains unchanged.
- A retained settled session may accept manual UI continuations during ordinary
  record retention. The first result remains delivered; each continuation produces
  a distinct terminal result and delivery ID.
