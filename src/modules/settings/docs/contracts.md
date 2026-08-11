# Settings contracts

## Public boundary

`public.ts` exports serializable settings commands, view snapshots, delegated action results, and application entry points. It does not export menu widgets or policy internals.

## Planned schemas

- `SettingsCommand`, `SettingsSnapshot`, and `SettingsActionResult`.
- `SettingsRow`, `SettingsNotice`, and delegated owner/action identifiers.

Exact fields are defined by TypeBox in the settings slices.

## Ports

Settings uses explicit reader and command ports for policy-owning modules and a renderer port for Pi translation. The configuration document repository is reached only through the owner of the setting.
