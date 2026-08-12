# Subagent runtime contracts

## Public boundary

`public.ts` exposes serializable lifecycle commands, results, events, snapshots, and application entry points. Consumers never receive a Pi `AgentSession` or TUI component.

## Implemented accepted-call schemas

- `AcceptedRunPolicySchema` defines the immutable policy snapshot captured after Agent authorization.
- `AgentInvocationSchema`, `ThinkingLevelSchema`, and `SystemPromptModeSchema` define the serializable invocation vocabulary used by that snapshot.
- `isAcceptedRunPolicy` is the receiving-boundary validator used before the runtime spawn path consumes a snapshot.

Lifecycle commands and snapshots remain planned for the slices that migrate runtime ownership.

Exact fields are owned by TypeBox schemas introduced one vertical slice at a time.

## Ports

`SessionDriver`, `WorktreeInspector`, `RuntimeClock`, `IdGenerator`, and `RuntimeScheduler` accept and return serialized values. Platform implementations translate live Pi handles and timers at the boundary.
