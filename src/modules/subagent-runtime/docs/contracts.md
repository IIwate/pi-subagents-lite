# Subagent runtime contracts

## Public boundary

`public.ts` exposes serializable lifecycle commands, results, events, snapshots, and application entry points. Consumers never receive a Pi `AgentSession` or TUI component.

## Planned schemas

- `SpawnRequest`, `StopRequest`, `InteractRequest`, and `InspectRequest`.
- `AcceptedRunPolicySnapshot` and `SubagentSnapshot`.
- `SessionEvent`, `RuntimeResult`, and `RuntimeFailure`.

Exact fields are owned by TypeBox schemas introduced one vertical slice at a time.

## Ports

`SessionDriver`, `WorktreeInspector`, `RuntimeClock`, `IdGenerator`, and `RuntimeScheduler` accept and return serialized values. Platform implementations translate live Pi handles and timers at the boundary.
