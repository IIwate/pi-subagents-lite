# Settings decisions

## Current

- Settings composes workflows; the module that defines a policy also validates and updates it.
- Renderer-independent settings state is translated to Pi menus at the platform boundary.
- Persistence succeeds before a new effective setting becomes visible to consumers.

## Superseded

- Menu callbacks that implement policy or publish in-memory state before persistence are retired. The [UI state matrix](./ui-states.md) owns workflows; capability commands own decisions.

## Implementation-only

- Existing menu file names, widget callbacks, and ConfigStore mutation names are not public settings concepts.
