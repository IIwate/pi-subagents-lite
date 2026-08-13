# Background result delivery state machine

```text
terminal -> persisted -> eligible -> presented -> acknowledged
                |           |           |
                +--------> failed <----+
                            |
                         restored -> eligible
```

| State | Entry condition | Exit condition |
|:--|:--|:--|
| `terminal` | Runtime emits a background terminal result | Repository append succeeds or failure is recorded |
| `persisted` | Result record is durable with parent session and origin entry | Origin remains active, explicit restoration occurs, or no delivery is eligible |
| `eligible` | Origin branch is active or reload/`/tree` restoration makes it eligible | One coalesced wake/presentation attempt starts |
| `presented` | Parent message or preflight injection succeeds | Parent turn settles successfully and acknowledgement is allowed |
| `acknowledged` | Explicit read or successful presentation is acknowledged by contract | Terminal record remains durable history or is hidden from pending state |
| `failed` | Append, wake, or presentation fails | A later eligible lifecycle event retries according to the approved rule |
| `restored` | Reload or explicit navigation returns to the origin subtree | Eligibility is recalculated; it does not bypass branch checks |

The named states are conceptual transitions. The snapshot stores `parentRunPhase`,
`parentWakeActive`, `lastWakeFailed`, `pending`, and `fallback`. `DeliveryEvent`
records each transition the public command returns.

Required invariants:

- A failed automatic wake does not retry itself indefinitely.
- Concurrent wake requests are coalesced.
- Entries from unrelated branches remain hidden.
- A forked or reloaded session cannot consume a record owned by another parent session.
- Exact AgentStatus acknowledgement joins the current parent turn's successful settlement.
