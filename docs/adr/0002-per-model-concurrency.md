# Hierarchical Provider and model concurrency ceilings

The AgentManager applies independent concurrency ceilings rather than one global
`maxConcurrent` pool or a precedence chain:

1. **Model ceiling**: an explicit `provider/modelId` limit, otherwise the
   fallback per-model limit (factory default: 4)
2. **Provider ceiling**: an optional shared hard limit across every model from
   that provider

Every run must satisfy both ceilings. Model limits may sum above the Provider
limit so one model can use otherwise-idle shared capacity. For example, Provider
4 with Model A 4 and Model B 4 still permits only four combined runs.

Configured via `/agents` > Concurrency settings and persisted in
`~/.pi/agent/subagents-lite.json`.

## Why

Different local models consume different GPU memory. A 4B model may fit several
runs while a 27B model fits only one. Provider-wide API or hardware limits must
still cap their combined usage; allowing an explicit Model limit to bypass that
shared ceiling makes the Provider setting misleading.

New Agent calls that hit either ceiling enter `queued` and start when both have
room. A settled-session continuation remains synchronous: it is rejected with a
local list-level concurrency block so the user can retry without creating a
hidden continuation queue.

The menu shows limits only for the parent model, currently authorized
alternates, and models retained by existing child sessions. Other saved limits
remain dormant under **Saved inactive limits** and reappear automatically when
relevant again.

## Trade-off

The manager tracks running counts for both model and Provider keys and acquires
or releases them together. This adds one map lookup per start, completion, or
continuation, while preserving burst capacity and making Provider limits real
shared ceilings.
