# Child screen contracts

## Public boundary

`public.ts` exposes serializable navigation commands, presentation snapshots, rendered lines, and interaction results. Pi components and layout references never cross inward.

## Implemented schemas

- `NavigatorCommandSchema` and `NavigatorCommandResultSchema` cover records, select, fold, keys, notices, and project.
- `NavigatorSnapshotSchema` and `RenderedLineSchema` are the serializable selection, fold, and presentation view.

Exact fields are defined once in TypeBox and are not duplicated here.

## Ports

`TextLayout` is the only port: width measurement, truncation, and wrapping over plain strings. The platform host pulls snapshots through the `project` command; the module never pushes to a renderer. Keyboard and Pi layout translation remain platform responsibilities.
