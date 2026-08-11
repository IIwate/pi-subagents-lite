# Child screen contracts

## Public boundary

`public.ts` exposes serializable navigation commands, presentation snapshots, rendered lines, and interaction results. Pi components and layout references never cross inward.

## Planned schemas

- `NavigatorCommand`, `NavigatorSnapshot`, and `NavigatorResult`.
- `ChildSelectionSnapshot`, `FooterSnapshot`, and `RenderedLine`.
- `LayoutOwnershipResult` for the platform renderer seam.

Exact fields are defined once in TypeBox and are not duplicated here.

## Ports

`NavigatorRenderer` applies a snapshot and returns a serializable ownership result. Keyboard and Pi layout translation remain platform responsibilities.
