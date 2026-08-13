# Subagent runtime decisions

## Current

- The application owns serializable lifecycle state; the Pi session driver owns live session handles and teardown.
- Running and queued work uses an immutable Accepted run policy.
- `AcceptedRunPolicySchema` is the complete boundary contract. The receiving parser returns a validated JSON copy; model, scope, Thinking, output, turn, and grace limits have no parallel runtime source.
- Scheduling, worktree targeting, and retention remain cohesive runtime components until an independent consumer requires a replacement boundary.

## Superseded

- Special failure-retention windows, retention extended by Child screen selection, queue revalidation, and manager-owned Pi teardown policy are retired. The [state machine](./state-machine.md) owns the surviving failure, retention, close, and late-event behavior.

## Implementation-only

- Host files talk to `createSubagentRuntime`. Live Pi sessions stay in `platform/pi`. Shell getter names are not public lifecycle concepts.
