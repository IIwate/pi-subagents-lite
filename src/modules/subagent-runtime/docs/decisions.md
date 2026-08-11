# Subagent runtime decisions

## Current

- The application owns serializable lifecycle state; the Pi session driver owns live session handles and teardown.
- Running and queued work uses an immutable Accepted run policy.
- Scheduling, worktree targeting, and retention remain cohesive runtime components until an independent consumer requires a replacement boundary.

## Superseded

- Manager and runner ownership history is classified in [refactoring-history-audit.md](../../../../docs/refactoring-history-audit.md) and must be transferred to state-machine tests or this document during Phase 0.

## Implementation-only

- `AgentManager`, `agent-runner`, and shell getter names are not public lifecycle concepts.
