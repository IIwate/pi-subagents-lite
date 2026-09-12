# Agent Note: Subagent retry awareness and queued input visibility

Status: implemented

## Problem

A steering message accepted while Pi waits in retry backoff may not enter session.messages until a later turn. Clearing the editor without another visible queue surface looks like lost input. Hiding retry state makes that delay unexplained, while aborting the whole child on every Esc discards the distinction between cancelling retry sleep and stopping the task.

## Decision

ExecutionSnapshot carries the native retry attempt and deadline together with queued entry IDs. TaskNavigationSource derives the countdown and projects it with the selected task's transcript. The source owns its subscription, and dispose releases it without affecting another runtime.

```ts type-equiv: AgentRetryState from src/types.ts
export interface AgentRetryState {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  startAt: number;
  errorMessage?: string;
}
```

Pending input remains visible before checkpoint consumption. Enter adds steering without changing control mode or cancelling backoff. Esc targets the selected operation, including an operation waiting in retry. Its cancellation follows native operation ownership and retains actual quota until execution returns.

Alt+Up and the host dequeue binding withdraw queued entries by identity. Only successfully cancelled entries return to the original task's draft; consumed entries are not resubmitted. An editor that cannot restore image attachments leaves that input queued. Main keeps the host's own queue handler.

## Alternatives considered

- **Keep only committed transcript messages.** This gives one display source, but acknowledged steering remains invisible during retry sleep and session setup. A separate pending surface represents that intermediate state.
- **Cancel retry whenever Enter is pressed.** This reduces waiting for some inputs, but silently changes Pi's queue semantics. Explicit Esc preserves the user's choice between queueing and cancelling backoff.
- **Terminate the child on every Esc or edit Main's queue.** Both reuse existing controls, but act on the wrong lifecycle or target while a child view is active. The selected child owns its retry and input queue.

## Consequences

The UI distinguishes accepted-but-queued input, retry delay and committed transcript. It still depends on Pi queue events and retry APIs; it does not guarantee network latency or provider recovery. Both pending render paths sanitize and flatten source text through [displayText](2026-09-10-terminal-preview-and-queue-sanitization.md), while dequeue preserves the original text. [Human takeover](../feature/2026-09-10-human-takeover-and-selective-delivery.md) independently controls automatic parent delivery.

## Evidence

`19ede8c` establishes retry state, immediate pending display and retry-first Esc. `c4e6441` adds child queue dequeue and its hint. `aa69dca` establishes event-driven timer restart and continuation statistics. These are UI/queue changes, not a new retry loop.

## Verification

[Navigator input](../../../../test/unit/ui/navigator/agent-navigator.input.test.ts), [interaction](../../../../test/unit/ui/navigator/agent-navigator.interaction.test.ts), [transcript](../../../../test/unit/ui/navigator/agent-navigator.transcript.test.ts), and [native navigation](../../../../test/scenarios/ui/task-navigation.test.ts) cover queue display, withdrawal identity, cancellation routing, and focus. These checks do not measure physical-terminal input latency.
