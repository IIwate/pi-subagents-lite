# Subagent runtime decisions

## Current

- The application owns serializable lifecycle state; the Pi session driver owns live session handles and teardown.
- Running and queued work uses an immutable Accepted run policy.
- `AcceptedRunPolicySchema` is the complete boundary contract. The receiving parser Checks a contract object and returns a validated JSON copy; it does not drop unknown Model fields. Pi vendor leftovers (`source`, undefined own keys) are projected only at bootstrap packaging. Model, scope, Thinking, output, turn, and grace limits have no parallel runtime source.
- List rows omit `acceptedPolicy`. The list never read that catalog; checking it on every refresh hitched the parent TUI, and stubbing the Check then hanging the live object back let callers write through to the record.
- Concurrency applies two independent ceilings, and a run starts only when both admit it: a model ceiling (an explicit `provider/modelId` limit, otherwise the fallback per-model limit) and an optional Provider ceiling shared across every model from that provider. Different local models consume very different GPU memory, while provider-wide API or hardware caps must still bound their combined usage — so model limits may sum above the Provider limit to share idle capacity, but never bypass it. The scheduler tracks running counts for both keys and acquires or releases them together; one extra map lookup per transition buys real shared ceilings.
- A new Agent call that hits either ceiling enters `queued`. A settled-session continuation is instead rejected synchronously with a list-level concurrency block, so the user retries explicitly and no hidden continuation queue forms.
- The capability default concurrency is `DEFAULT_CONCURRENCY_LIMIT` (4): the fallback per-model ceiling when no Model override exists. ADR 0002 recorded that default; changing it is a product decision, not a silent scheduler tweak.
- Limits are persisted as a runtime-owned fragment; the settings page projects the actionable inventory (parent model, authorized alternates, models retained by live children) and lists other saved limits as `Inactive Provider ·` / `Inactive Model ·` rows until their prerequisite returns.
- Admission control is injected as a `ConcurrencyScheduler`, defaulting to the two-ceiling implementation above. The runtime keeps the default because no consumer schedules work without it, but the seam exists so a different policy — a global pool, a cost-aware ceiling — is substituted at construction rather than by editing the lifecycle. Retention and worktree targeting stay inline: retention is a property of the lifecycle's own terminal states, and worktree targeting already crosses a port.

## Superseded

- Special failure-retention windows, retention extended by Child screen selection, queue revalidation, and manager-owned Pi teardown policy are retired. The [state machine](./state-machine.md) owns the surviving failure, retention, close, and late-event behavior.
- One global `maxConcurrent` pool and a model-over-provider precedence chain are retired: a global pool ignores per-model capacity differences, and precedence lets an explicit model limit silently defeat a provider's shared cap, making that setting misleading.

## Implementation-only

- Host files talk to `createSubagentRuntime`. Live Pi sessions stay in `platform/pi`. Shell getter names are not public lifecycle concepts.
