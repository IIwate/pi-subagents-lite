# Settings contracts

## Public boundary

`public.ts` exports serializable settings commands, view snapshots, action results, and the `createSettings` entry point. It does not export menu widgets or policy internals.

## Implemented schemas

- `SettingsCommand` — `open`, `select`, `set-value`, `back`, plus the keyed-limit commands `update-limit` (integer or `null` to remove) and `add-limit` (key plus integer).
- `SettingsSnapshot` — page id, title, `presentation` (menu vs. form), rows, and an optional notice; `SettingsRow` and `SettingsNotice` carry only rendering data. Row kinds: `category`, `toggle`, `choice`, `numeric` (with `min`/`fallback` hints), `action` (single-choice trigger, optionally gated by a `confirm` question), `limit` (keyed override with a raw `input` value), and `picker` (choose a key from `choices`, then a limit).
- `SettingsResult` — a snapshot plus an optional effect (`close`, or the transitional `open-legacy-category` that disappears with the last monolithic menu), or a serializable `invalid-command`/`unknown-row`/`invalid-value` failure.
- `DisplayToggleId`, `DisplaySettingsView`, `SettingsUpdateResult`, and `RootSummaries` define the owner-facing fragment boundaries.
- `SpawnSettingsView`/`SpawnSettingUpdate` and `PromptSettingsView`/`PromptSettingUpdate` (with `SystemPromptMode`) define the spawn-options and system-prompt fragment boundaries.
- `ConcurrencySettingsView`/`ConcurrencyLimitUpdate` define the concurrency boundary: saved overrides plus the active provider/model inventory computed by the owner.

Pages added by later slices extend these schemas rather than bypassing them.

## Ports

- `DisplaySettingsOwner` reads and commits the display fragment; `update` persists before publishing and reports failure explicitly.
- `SpawnSettingsOwner` reads and commits the spawn fragment (force background, grace turns, default-agent availability); owner-side effects such as the agent registry flag run only after a successful commit.
- `PromptSettingsOwner` reads and commits the prompt fragment and owns the custom prompt file lifecycle (`createCustomPromptFile`); the file path and existence come from the owner so settings never touches the filesystem.
- `ConcurrencySettingsOwner` reads the concurrency view and commits limit updates; the fragment's shape and runtime effect belong to the subagent-runtime module, and the live scheduler is republished only after a successful commit.
- `SettingsSummaryReader` provides live root-page summaries.

The configuration document repository is reached only through the owner of the setting; the Pi renderer consumes snapshots through `platform/pi/tui/settings-screen.ts`.
