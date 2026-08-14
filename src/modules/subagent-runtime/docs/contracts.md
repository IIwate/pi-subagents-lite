# Subagent runtime contracts

## Public boundary

`public.ts` exposes serializable lifecycle commands, results, events, snapshots, and application entry points. Consumers never receive a Pi `AgentSession` or TUI component.

## Implemented accepted-call schemas

- `AcceptedRunPolicySchema` defines the complete immutable policy snapshot captured after Agent authorization: the copied definition and loading policy, prompt and context modes, selected and parent models, scoped models, Thinking selection, output and turn limits, and grace turns.
- `AgentInvocationSchema`, `ThinkingLevelSchema`, and `SystemPromptModeSchema` define the serializable invocation vocabulary used by that snapshot.
- `AcceptedModelSnapshotSchema` and `AcceptedScopedModelSchema` describe the serializable Pi model data needed by the platform session driver.
- `parseAcceptedRunPolicy` accepts only a contract object: plain JSON, `AcceptedRunPolicySchema`, and consistent derived parent-model / output / turn values. It does not project vendor leftovers. Pi 0.84.1 model snapshots are projected at bootstrap packaging before this parser runs.
- `AgentListSnapshotSchema` is the list-row contract: the same snapshot fields except `acceptedPolicy`. `listSnapshots()` Checks this schema. Full `AgentSnapshotSchema` (including the real accepted call) remains the gate for `getSnapshot`, settlement, and command results.

- `ConcurrencyLimitsSchema` and `ConcurrencyDecisionSchema` define hierarchical reserve/release decisions.
- `ConcurrencyLimitsFragmentSchema` and `ConcurrencyLimitsUpdateSchema` define the persisted `concurrency` document section this module owns: `parseConcurrencyLimitsFragment` tolerates hand-edited junk (invalid entries drop, an invalid default becomes the capability default), `applyConcurrencyLimitsUpdate` and `runtimeLimitsFromFragment` Check inbound and outbound so a bad update cannot commit then throw on `replaceLimits`.
- `AgentCommandSchema`, `AgentCommandResultSchema`, `AgentSnapshotSchema`, and `AgentListSnapshotSchema` define the serializable lifecycle seam for spawn, stop, interact, inspect, pin, expire, close, and list.
- `SessionStartRequestSchema` and `SessionEventSchema` define the session-driver port traffic.

Exact fields are owned by TypeBox schemas introduced one vertical slice at a time.

## Ports

`SessionDriver`, `WorktreeInspector`, `RuntimeClock`, `IdGenerator`, and `RuntimeScheduler` accept and return serialized values. Platform implementations translate live Pi handles and timers at the boundary.
