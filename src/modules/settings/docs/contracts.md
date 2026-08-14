# Settings contracts

## Public boundary

`public.ts` exports serializable settings commands, view snapshots, action results, and the `createSettings` entry point. It does not export menu widgets or policy internals.

## Implemented schemas

- `SettingsCommand` — `open`, `select`, `set-value`, `back`, plus the keyed-limit commands `update-limit` (integer or `null` to remove) and `add-limit` (key plus integer).
- `SettingsSnapshot` — page id, title, `presentation` (menu vs. form), rows, and an optional notice; `SettingsRow` and `SettingsNotice` carry only rendering data. Row kinds: `category`, `toggle`, `choice`, `numeric` (with `min`/`fallback` hints), `action` (single-choice trigger, optionally gated by a `confirm` question), `limit` (keyed override with a raw `input` value), `picker` (choose a key from `choices`, then a limit), and `note` (non-selectable context line).
- `SettingsResult` — a snapshot plus an optional `close` effect, or a serializable `invalid-command`/`unknown-row`/`invalid-value` failure.
- `DisplayToggleId`, `DisplaySettingsView`, `SettingsUpdateResult`, and `RootSummaries` define the owner-facing fragment boundaries. A failed `SettingsUpdateResult` may include an optional code that embeds `ConfigurationCommitFailureCodeSchema`.
- `SpawnSettingsView`/`SpawnSettingUpdate` and `PromptSettingsView`/`PromptSettingUpdate` (with `SystemPromptMode`) define the spawn-options and system-prompt fragment boundaries.
- `ConcurrencySettingsView`/`ConcurrencyLimitUpdate` define the concurrency boundary: saved overrides plus the active provider/model inventory computed by the owner. `ConcurrencyLimitUpdateSchema` embeds the runtime's `ConcurrencyLimitsUpdateSchema`.
- `DebugSettingsView`, `DebugAgentType`, `DebugDiagnosticsView`, `DebugFault`, and `DebugStatusPreview` define the debug boundary; the page formats reports from this structured JSON so owners never emit display text. Status and fault embed the runtime's `AgentStatusSchema` and `DebugFaultKindSchema`.
- `SYSTEM_PROMPT_MODES` is derived from prompt's `SystemPromptModeSchema` and exported for bootstrap's `VALID_SYSTEM_PROMPT_MODES`.
- `ModelAccessRootView`, `ModelAccessAgentRow`, `ModelAccessAgentDetailView`, `ModelAccessProvidersView`, `ModelAccessModelsView`, `ModelAccessThinkingTarget`, `ModelAccessThinkingView`, `ModelAccessUnavailableProvider`, and `ModelAccessUnavailableRule` define the model-access boundary as precomputed views; pages never derive policy from raw rules. Thinking levels embed `ThinkingLevelSchema`; the empty-string sentinel on `parentDefaultLevel` is the only extra token, used when no default is available.

## Ports

- `DisplaySettingsOwner` reads and commits the display fragment; `update` persists before publishing and reports failure explicitly.
- `SpawnSettingsOwner` reads and commits the spawn fragment (force background, grace turns, default-agent availability); owner-side effects such as the agent registry flag run only after a successful commit.
- `PromptSettingsOwner` reads and commits the prompt fragment and owns the custom prompt file lifecycle (`createCustomPromptFile`); the file path and existence come from the owner so settings never touches the filesystem.
- `ConcurrencySettingsOwner` reads the concurrency view and commits limit updates; the fragment's shape and runtime effect belong to the subagent-runtime module, and the live scheduler is republished only after a successful commit.
- `DebugSettingsOwner` supplies the agent-type catalogue and runtime diagnostics as structured JSON and applies the session-local status preview and one-shot fault (REQ-RUNTIME-007); owner failures mean session unavailability, reported as informational notices rather than save errors.
- `ModelAccessSettingsOwner` serves every model-access view and applies one atomic policy transition per verb (enable routing, provider/parent/model/thinking toggles, rule cleanup, full reset); each transition is evaluated by the model-access module and committed before it becomes effective.
- `SettingsSummaryReader` provides live root-page summaries.

The configuration document repository is reached only through the owner of the setting; the Pi renderer consumes snapshots through `platform/pi/tui/settings-screen.ts`.
