# Child screen contracts

## Public boundary

`public.ts` exposes serializable navigation commands, presentation snapshots, rendered lines, and interaction results. Pi components and layout references never cross inward.

## Implemented schemas

- `NavigatorCommandSchema` and `NavigatorCommandResultSchema` cover complete record replacement, selected-stream refresh, select, fold, keys, notices, and project.
- `NavigatorSnapshotSchema` and `RenderedLineSchema` are the serializable selection, fold, and presentation view.
- `ChildStatusSchema` aliases the runtime's `AgentStatusSchema`; `ChildSessionViewSchema` aliases `SessionInspectResultSchema`; `ChildStreamViewSchema` aliases `SessionStreamResultSchema`; `debugFaultKind` embeds `DebugFaultKindSchema`. Complete records own stable session history, while `refresh-stream` overlays only the selected ID's transient streaming fields. A stale ID is ignored and cannot change selection.
- `PendingResultCountSchema` is the checked integer (`>= 1`) used on replace-records and the snapshot; off-contract counts are dropped rather than copied.
- Session and invocation `thinkingLevel` embed `ThinkingLevelSchema` from model-access; this screen does not restate the vocabulary.

Exact fields are defined once in TypeBox and are not duplicated here.

## Ports

`TextLayout` is the only port: width measurement, truncation, and wrapping over plain strings. The platform host pulls snapshots through the `project` command and supplies schema-checked record/stream commands; the module never pushes to a renderer. Keyboard, runtime inspection, and Pi layout translation remain platform responsibilities.
