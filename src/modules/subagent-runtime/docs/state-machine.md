# Subagent runtime state machine

The runtime state machine owns serializable lifecycle facts. Pi session handles, timers, and abort signals stay in platform implementations.

```text
accepted -> queued -> setting-up -> running -> settling -> terminal
    |         |          |            |           |
    +-------> stopped <---+------------+-----------+
                               |
                         retained -> closed
```

| State | Accepted inputs | Observable result | Time owner |
|:--|:--|:--|:--|
| `accepted` | authorized spawn | immutable Accepted run policy | none |
| `queued` | concurrency full | queued snapshot | scheduler/clock |
| `setting-up` | capacity available | setup progress or failure | session driver |
| `running` | session ready | progress and interaction availability | session driver |
| `settling` | provider terminal event | one terminal candidate | session driver |
| `terminal` | successful/error/stopped settlement | terminal result and delivery input | runtime clock |
| `retained` | terminal cleanup window or pin | selectable record while retained | runtime clock |
| `closed` | expiry, explicit removal, shutdown | no volatile record; durable delivery remains separate | none |
| `stopped` | explicit stop or foreground interrupt | stopped record and no future execution | runtime clock |

Required invariants:

- Queueing never revalidates the Accepted run policy.
- Stop is idempotent and does not retract a previously persisted terminal result.
- Continuation is a new prompt to a still-settled live session, not persisted resume. A successful continue delivers a new terminal result and does not retract the first delivery.
- Cleanup never removes a pinned record and never changes delivery eligibility.
- Late platform events are ignored or translated through the session ID without reviving a closed record.
- Retention start, pause, expiry, pin, continuation, and close decisions use an injected runtime clock.
- Close is idempotent across setup, running, settling, closing, and closed event traces. The Pi session driver owns shutdown emission, abort, bounded wait, disposal, and late platform events.

Superseded states do not appear in the machine: an `Error` result has no special 30-minute retention window, selecting the Child screen does not pause cleanup, and concurrency-blocked continuation does not create a second retention mode. Restoring any of these states requires an approved product and domain-model change.
