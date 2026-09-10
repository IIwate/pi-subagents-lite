# Agent Note: Subagent retry awareness and queued input visibility

Status: implemented

## Problem

A steering message accepted while Pi waits in retry backoff may not enter session.messages until a later turn. Clearing the editor without another visible queue surface looks like lost input. Hiding retry state makes that delay unexplained, while aborting the whole child on every Esc discards the distinction between cancelling retry sleep and stopping the task.

## Decision

AgentRecord.execution.retryState reflects auto_retry_start/auto_retry_end. Manager subscribes once when adopting the session; Pi session disposal releases those lifecycle listeners. Per-prompt usage/outcome subscriptions have a separate finally cleanup owned by the [runner](2026-09-10-assistant-outcomes-retries-and-turn-budgets.md).

```ts type-equiv: AgentRetryState from src/types.ts
export interface AgentRetryState {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  startAt: number;
  errorMessage?: string;
}
```

The active child pending area displays session.getSteeringMessages and pendingSteers retained before session creation. A transcript fallback displays the same information when the dock swap is inactive. Retry countdown state participates in the render signature; queue_update and manager progress restart rendering after an idle period. Displaying queued text does not append a second user message to the transcript.

Enter queues input without automatically cancelling backoff. Esc first asks manager.abortRetry for the selected running child, then falls back to child abort, then normal editor handling. abortRetry calls Pi's abortRetry and clears the UI retry state; Pi owns whether the current run settles or queued work executes next. This call alone does not promise a completed continuation or final report to Main.

Alt+Up delegates app.message.dequeue to the selected child. It drains pending pre-session steers and Pi steering/followUp queues, combines returned text with any existing draft, and reports the restored count. In Main the original handler remains active. This is a text-returning API; it does not claim to reconstruct image attachments. The visible hint is `Alt+Up to edit all queued messages`.

## Alternatives considered

- **Keep only committed transcript messages.** This gives one display source, but acknowledged steering remains invisible during retry sleep and session setup. A separate pending surface represents that intermediate state.
- **Cancel retry whenever Enter is pressed.** This reduces waiting for some inputs, but silently changes Pi's queue semantics. Explicit Esc preserves the user's choice between queueing and cancelling backoff.
- **Terminate the child on every Esc or edit Main's queue.** Both reuse existing controls, but act on the wrong lifecycle or target while a child view is active. The selected child owns its retry and input queue.

## Consequences

The UI distinguishes accepted-but-queued input, retry delay and committed transcript. It still depends on Pi queue events and retry APIs; it does not guarantee network latency or provider recovery. Raw pending text currently bypasses displayText, a separate [rendering proposal](../../proposed/bug-fix/2026-09-10-terminal-preview-and-queue-sanitization.md) records that gap. [Human takeover](../feature/2026-09-10-human-takeover-and-selective-delivery.md) independently controls automatic parent delivery.

## Evidence

`19ede8c` establishes retry state, immediate pending display and retry-first Esc. `c4e6441` adds child queue dequeue and its hint. `aa69dca` establishes event-driven timer restart and continuation statistics. These are UI/queue changes, not a new retry loop.

## Verification

[navigator input](../../../../test/unit/ui/navigator/agent-navigator.input.test.ts), [interaction](../../../../test/unit/ui/navigator/agent-navigator.interaction.test.ts), [transcript](../../../../test/unit/ui/navigator/agent-navigator.transcript.test.ts), and [manager interaction](../../../../test/unit/agents/manager/agent-manager.interaction.test.ts) verify routing, immediate queue display, retry cancellation calls and dequeue. [Pi session scenarios](../../../../test/scenarios/agents/pi-session.test.ts) separately exercise Pi's actual retry loop with offline providers. These tests do not constitute physical-terminal input-latency measurements.
