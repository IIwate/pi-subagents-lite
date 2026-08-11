# Background result delivery contracts

## Public boundary

`public.ts` exports serialized delivery commands, events, snapshots, and application entry points. Parent-session entries and Pi lifecycle handles remain behind ports.

## Planned schemas

- `DeliveryCommand`, `DeliveryEvent`, and `DeliverySnapshot`.
- `BackgroundResultRecord` and `DeliveryFailure`.
- `ParentLifecycleEvent` and `AcknowledgementResult`.

Exact fields are defined by TypeBox in the relevant delivery slices.

## Ports

`ResultRepository` reads, appends, and acknowledges serialized records. `ParentMessenger` delivers one serialized result message. Active-branch discovery is a Pi platform port.
