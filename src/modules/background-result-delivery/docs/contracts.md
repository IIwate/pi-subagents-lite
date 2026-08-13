# Background result delivery contracts

## Public boundary

`public.ts` exports serialized delivery commands, events, snapshots, and application entry points. Parent-session entries and Pi lifecycle handles remain behind ports. Events are returned from each successful command; they are not a separate subscription.

## Implemented schemas

- `DeliveryCommandSchema` and `DeliveryCommandResultSchema` cover record-terminal, parent lifecycle, restore, `/tree`, inspect, and dispose.
- `BackgroundResultRecordSchema` and `DeliverySnapshotSchema` are the serializable pending/fallback view.

Exact fields are owned by those TypeBox schemas.

## Ports

`ResultRepository` reads, appends, and acknowledges serialized records. `ParentMessenger` delivers one serialized result message. Active-branch discovery is a Pi platform port.
