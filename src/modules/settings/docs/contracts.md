# Settings contracts

## Public boundary

`public.ts` exports serializable settings commands, view snapshots, action results, and the `createSettings` entry point. It does not export menu widgets or policy internals.

## Implemented schemas

- `SettingsCommand` — `open`, `select`, `set-value`, `back`.
- `SettingsSnapshot` — page id, title, `presentation` (menu vs. form), rows, and an optional notice; `SettingsRow` and `SettingsNotice` carry only rendering data.
- `SettingsResult` — a snapshot plus an optional effect (`close`, or the transitional `open-legacy-category` that disappears with the last monolithic menu), or a serializable `invalid-command`/`unknown-row`/`invalid-value` failure.
- `DisplayToggleId`, `DisplaySettingsView`, `SettingsUpdateResult`, and `RootSummaries` define the owner-facing fragment boundaries.

Pages added by later slices extend these schemas rather than bypassing them.

## Ports

- `DisplaySettingsOwner` reads and commits the display fragment; `update` persists before publishing and reports failure explicitly.
- `SettingsSummaryReader` provides live root-page summaries.

The configuration document repository is reached only through the owner of the setting; the Pi renderer consumes snapshots through `platform/pi/tui/settings-screen.ts`.
