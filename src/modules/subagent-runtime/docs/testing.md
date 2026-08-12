# Subagent runtime testing

## Primary seam

Test lifecycle commands and emitted events through the runtime public surface with in-memory ports.

The accepted-call contract test uses an independent literal snapshot and JSON round-trip. The resolver path also validates its returned policy against `AcceptedRunPolicySchema` before runtime consumption.

## Required scenarios

- Authorization acceptance locks the complete run policy.
- Model and Provider ceilings queue and release work hierarchically.
- Foreground interruption stops and retains records while background work remains detached.
- Setup, provider, abort, timeout, continuation, and close failures produce ordinary terminal outcomes.
- Retention, pinning, cleanup, late usage, and idempotent shutdown use an injected clock.
- Special failure retention, selection-paused cleanup, and queue revalidation remain absent regression cases.
- Worktree validation is delegated through its serializable inspector port.

## Fixtures and doubles

Use deterministic clocks, IDs, schedulers, and session drivers. Pi adapter contract tests are separate. No internal runtime module mocks or private map assertions are allowed.
