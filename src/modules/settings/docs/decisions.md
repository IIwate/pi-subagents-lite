# Settings decisions

## Current

- Settings composes workflows; the module that defines a policy also validates and updates it.
- Renderer-independent settings state is translated to Pi menus at the platform boundary.
- Persistence succeeds before a new effective setting becomes visible to consumers.

## Superseded

- Repeated menu and ConfigStore side-effect patches are historical evidence in [refactoring-history-audit.md](../../../../docs/refactoring-history-audit.md), not policy requirements.

## Implementation-only

- Existing menu file names, widget callbacks, and ConfigStore mutation names are not public settings concepts.
