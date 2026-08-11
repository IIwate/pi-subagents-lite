# Settings

## User outcomes

Users can inspect and update the existing Agent, Model access, Thinking, concurrency, display, prompt-mode, and debug settings through `/agents`. The settings workflow reports failed persistence instead of presenting a value that was not saved.

## Requirements

### REQ-SETTINGS-001 — One settings workflow

`/agents` remains the single management workflow. It presents current effective values, actionable choices, and the existing inactive-limit management paths without owning the policy it displays.

### REQ-SETTINGS-002 — Delegated policy updates

Each setting update is evaluated by the capability that owns the policy. The settings workflow does not duplicate Model access, concurrency, prompt assembly, Agent discovery, or Child screen rules.

### REQ-SETTINGS-003 — Immediate future-call effect

Successful settings changes apply to future Agent calls according to the existing policy. Running and queued calls retain their Accepted run policy.

### REQ-CONFIG-001 — Atomic persistence failure correction

If a setting cannot be persisted, the workflow shows an explicit failure and keeps the previous effective value. It does not partially update related settings or synchronize a manager or navigator with an unpersisted value.

### REQ-SETTINGS-005 — Renderer-independent state

Settings state and action results remain meaningful without Pi TUI. Pi input translation and rendering remain local to the host integration.

## Out of scope

- New settings, menus, commands, or prompt inspection capabilities.
- Automatic migration of the persisted configuration file to a new physical schema.

## Acceptance intent

Acceptance examples cover settings navigation, delegated updates, quick model setup, concurrency and display options, prompt mode choices, atomic persistence failure, and the effect boundary between current and future calls.
