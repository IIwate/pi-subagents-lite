# Subagent runtime decisions

## Current

- The application owns serializable lifecycle state; the Pi session driver owns live session handles and teardown.
- Running and queued work uses an immutable Accepted run policy.
- `AcceptedRunPolicySchema` is the complete boundary contract. The receiving parser returns a validated JSON copy; model, scope, Thinking, output, turn, and grace limits have no parallel runtime source.
- Concurrency applies two independent ceilings, and a run starts only when both admit it: a model ceiling (an explicit `provider/modelId` limit, otherwise the fallback per-model limit) and an optional Provider ceiling shared across every model from that provider. Different local models consume very different GPU memory, while provider-wide API or hardware caps must still bound their combined usage — so model limits may sum above the Provider limit to share idle capacity, but never bypass it. The scheduler tracks running counts for both keys and acquires or releases them together; one extra map lookup per transition buys real shared ceilings.
- A new Agent call that hits either ceiling enters `queued`. A settled-session continuation is instead rejected synchronously with a list-level concurrency block, so the user retries explicitly and no hidden continuation queue forms.
- Limits are persisted as a runtime-owned fragment; the settings page projects only the actionable inventory (parent model, authorized alternates, models retained by live children) while other saved limits stay dormant under Saved inactive limits until relevant again.
- Scheduling, worktree targeting, and retention remain cohesive runtime components until an independent consumer requires a replacement boundary.

## Superseded

- Special failure-retention windows, retention extended by Child screen selection, queue revalidation, and manager-owned Pi teardown policy are retired. The [state machine](./state-machine.md) owns the surviving failure, retention, close, and late-event behavior.
- One global `maxConcurrent` pool and a model-over-provider precedence chain are retired: a global pool ignores per-model capacity differences, and precedence lets an explicit model limit silently defeat a provider's shared cap, making that setting misleading.

## Implementation-only

- Host files talk to `createSubagentRuntime`. Live Pi sessions stay in `platform/pi`. Shell getter names are not public lifecycle concepts.
