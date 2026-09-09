# Agent Note: Subagent screen retry awareness and steering visibility

Status: implemented

## Problem

When a user took over a subagent session and typed while the subagent encountered an auto-retryable error, the user experienced an apparent input freeze:
1. Entering text cleared the editor, but the subagent transcript displayed nothing until the subagent's retry delay expired, the retry attempt ran, and the subsequent turn pulled queued steering messages into `session.messages`.
2. The subagent view completely hid auto-retry countdown status indicators (`auto_retry_start`/`auto_retry_end`), leaving the user blind to the fact that backoff sleep was in progress.
3. Pressing `Esc` while taking over a subagent unconditionally invoked `manager.abort()`, terminating the entire subagent instead of cancelling backoff delay via `session.abortRetry()` as native Pi interactive mode does.

## Decision

Subagent screen behavior aligns with native Pi interactive mode:
1. `AgentRecord.execution.retryState` tracks active retry status via session lifecycle events (`auto_retry_start`, `auto_retry_end`).
2. Queued steering messages (`session.getSteeringMessages?.()` and `record.execution.pendingSteers`) render in the subagent view (`pendingContainer` and transcript fallback) immediately upon submission.
3. An active auto-retry delay countdown displays via `childStatusRender` in `statusContainer` and the transcript header badge.
4. Pressing `Esc` in subagent view checks `abortActiveRetry()` first; if active, it cancels retry sleep via `session.abortRetry()` and immediately yields execution to pending input rather than terminating the subagent.

```ts type-equiv: AgentRetryState from src/types.ts
export interface AgentRetryState {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  startAt: number;
  errorMessage?: string;
}
```

## Alternatives considered

- **Do nothing / Status quo** — The user had to wait out the exponential backoff sleep without visible feedback. Rejected because human takeover specifically requires responsive steering and clear visibility into subagent state.
- **Aggressively abort retry on input submission** — Automatically call `session.abortRetry()` whenever input is sent to a retrying subagent. Strongest argument: provides instantaneous turn execution without waiting for user to press `Esc`. Rejected because it diverges from native Pi semantics where `Enter` queues steering messages and `Esc` cancels backoff sleep; implicit cancellation would violate the principle of least surprise.

## Consequences

- **Benefits**: Subagent screen provides immediate feedback on user input submission, renders transparent retry countdowns, and preserves subagent continuity on `Esc`.
- **Costs & upper bounds**: Additional session event listeners wired at creation; cleared on teardown.

## Verification

Run unit and integration suites:
```bash ignore-check
bun run test test/unit/ui/navigator/ test/unit/agents/manager/
```
Verify agent note integrity and type alignment:
```bash ignore-check
bun run verify-notes
```
