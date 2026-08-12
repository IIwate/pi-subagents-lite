# Subagent runtime contracts

## Public boundary

`public.ts` exposes serializable lifecycle commands, results, events, snapshots, and application entry points. Consumers never receive a Pi `AgentSession` or TUI component.

## Implemented accepted-call schemas

- `AcceptedRunPolicySchema` defines the complete immutable policy snapshot captured after Agent authorization: the copied definition and loading policy, prompt and context modes, selected and parent models, scoped models, Thinking selection, output and turn limits, and grace turns.
- `AgentInvocationSchema`, `ThinkingLevelSchema`, and `SystemPromptModeSchema` define the serializable invocation vocabulary used by that snapshot.
- `AcceptedModelSnapshotSchema` and `AcceptedScopedModelSchema` describe the serializable Pi model data needed by the platform session driver.
- `parseAcceptedRunPolicy` accepts only plain JSON values, verifies the parent-model key and derived output/turn limits, then returns a separately validated JSON copy for runtime consumption.

Lifecycle commands and snapshots remain planned for the slices that migrate runtime ownership.

Exact fields are owned by TypeBox schemas introduced one vertical slice at a time.

## Ports

`SessionDriver`, `WorktreeInspector`, `RuntimeClock`, `IdGenerator`, and `RuntimeScheduler` accept and return serialized values. Platform implementations translate live Pi handles and timers at the boundary.
