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

### REQ-CONFIG-002 — Canonical host resource locations

The global configuration document, the custom prompt file, and global Agent definitions live in the Pi agent directory reported by the host. Project resource directories use Pi's project config directory name. There is no fallback to former locations and no automatic migration of files from a previous location; relocating the agent directory is done through Pi's own mechanism.

### REQ-CONFIG-003 — Project configuration override layer

For a project the Pi context reports as trusted, `subagents-lite.json` under the project's Pi config directory is an override layer above the global document: a project value overrides only the keys it names, absence means inheritance, and the merged effective values are never written back. The layer has four states — untrusted, absent, loaded, malformed. Untrusted sessions never read the file and offer no project write target. A write from settings changes only the selected layer; clearing an override the layer never had is a no-op that creates no file. Removing a layer's explicit fallback default is its own gesture: a project removal restores inheritance and a global removal restores the factory default. A malformed project file is excluded from the effective values, is refused as a write target, and is never overwritten or auto-repaired. Failed persistence keeps the previous effective value (REQ-CONFIG-001). This requirement does not promise that the file's presence triggers an explicit Pi trust confirmation.

### REQ-SETTINGS-005 — Renderer-independent state

Settings state and action results remain meaningful without Pi TUI. Pi input translation and rendering remain local to the host integration.

## Out of scope

- New settings, menus, commands, or prompt inspection capabilities beyond the project write target and provenance display required by REQ-CONFIG-003 and REQ-RUNTIME-008.
- Automatic migration of the persisted configuration file to a new physical schema or from a former location (REQ-CONFIG-002).

## Acceptance intent

Acceptance examples cover settings navigation, delegated updates, quick model setup, concurrency and display options, prompt mode choices, atomic persistence failure, the effect boundary between current and future calls, canonical resource locations, and the project override layer's four states, write-target routing, and no-op clears.
