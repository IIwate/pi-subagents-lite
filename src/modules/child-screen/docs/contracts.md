# Child screen contracts

## Public boundary

`public.ts` exposes serializable navigation commands, presentation snapshots, rendered lines, and interaction results. Pi components and layout references never cross inward.

## Implemented schemas

- `NavigatorCommandSchema` and `NavigatorCommandResultSchema` cover replace-records, select, toggle-fold, and inspect.
- `NavigatorSnapshotSchema` is the serializable selection, fold, and record list.

## Planned schemas

- `FooterSnapshot`, `RenderedLine`, and `LayoutOwnershipResult` remain for later Child screen slices.

Exact fields are defined once in TypeBox and are not duplicated here.

## Ports

`NavigatorRenderer` applies a snapshot and returns a serializable ownership result. Keyboard and Pi layout translation remain platform responsibilities.
