# Subagent runtime testing

## Primary seam

Test lifecycle commands and emitted events through the runtime public surface with in-memory ports.

The accepted-call contract test uses an independent literal snapshot and JSON round-trip. The resolver path also validates its returned policy against `AcceptedRunPolicySchema` before runtime consumption.

Lifecycle commands are exercised through `createSubagentRuntime` with in-memory clock, ID, scheduler, and session-driver ports. The Worktree inspector is exercised at the Agent tool pre-spawn seam, while lifecycle tests pass only its validated snapshot. Session-driver contract coverage records setup, progress, completion, error, abort, continuation, and close events.

## Required scenarios

- Authorization acceptance locks the complete run policy.
- Concurrency accounting derives its model bucket only from the accepted model snapshot, even when an untyped caller supplies a conflicting extra field.
- Model and Provider ceilings queue and release work hierarchically.
- Closing a reserved running snapshot releases its slot and starts the next queued snapshot.
- Stop, close, and dispose during setup abort immediately, reject late readiness, do not flush pending steers, and never restore a closed session.
- Foreground interruption stops and retains records while background work remains detached.
- Setup, provider, abort, timeout, continuation, and close failures produce ordinary terminal outcomes.
- Outbound `execute()` results that fail `AgentCommandResultSchema` are refused as `invalid-command` rather than handed out.
- Retention, pinning, cleanup, late usage, and idempotent shutdown use an injected clock.
- Special failure retention, selection-paused cleanup, and queue revalidation remain absent regression cases.
- Worktree validation runs once through the tool's serializable inspector port. Its resolved path is the only worktree field lifecycle accepts; the raw path/cwd shape and an off-contract inspect result are refused.
- `markResult(fields)` Checks the same `mark-result` command schema as `execute`.
- The persisted limits fragment clamps/rounds finite numbers without expanding effective capacity, drops values without numeric meaning, updates strictly, and derives a schema-valid scheduler shape (`test/modules/subagent-runtime/limits-fragment.test.ts`). Invalid updates throw instead of returning a committable fragment.
- `listSnapshots()` ranks attention, running, queued, then archive; pins lift within each rank, terminal rows use completion recency, active rows use start/FIFO order, and continuations reposition from their refreshed timestamps (`test/modules/subagent-runtime/lifecycle.test.ts`).
- `inspectSessionStream()` fails closed on an off-contract driver view and never carries stable message history.

## Fixtures and doubles

Use deterministic clocks, IDs, schedulers, and session drivers. Pi adapter contract tests are separate. No internal runtime module mocks or private map assertions are allowed.
