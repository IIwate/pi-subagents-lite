# Background result delivery contracts

## Public boundary

`public.ts` exports serialized delivery commands, events, snapshots, and application entry points. Parent-session entries and Pi lifecycle handles remain behind ports. Events are returned from each successful command; they are not a separate subscription.

## Implemented schemas

- `DeliveryCommandSchema` and `DeliveryCommandResultSchema` cover record-terminal, spawn-time origin tracking, parent lifecycle, restore, `/tree`, inspect, and dispose. `inspect` is the only cross-module exact-result query and may name both Agent and delivery IDs.
- `BackgroundResultRecordSchema` and `DeliverySnapshotSchema` are the serializable pending/fallback view. `DeliveryStatusSchema` aliases the runtime's `AgentStatusSchema` for stored lifecycle snapshots, while `record-terminal` additionally checks the runtime-owned `TerminalAgentStatusSchema` before persistence or wake.

Exact fields are owned by those TypeBox schemas.

## Ports

`ResultRepository` reads a construction snapshot, performs an on-demand Agent/delivery lookup against current durable session entries, appends, and acknowledges serialized records. Automatic pending state remains in the delivery state machine; every explicit exact query rereads the repository before merging pending, latest, and fallback views. `ParentMessenger` delivers one serialized result message. Active-branch discovery is a Pi platform port.

Records arriving from the repository and the fallback inbox are validated against `BackgroundResultRecordSchema` and the current parent-session identity at construction; off-contract or foreign-session entries are dropped. Exact durable inspect applies the same session filter, and a checked inspected record is hydrated into current pending/presented tracking before settlement acknowledgement. Both stores outlive this process, so a record written by an older or corrupted build is an inbound value, not a trusted one. Dropping loses one result rather than poisoning the pending view for the session.
