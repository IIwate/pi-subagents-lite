# Settings decisions

## Current

- Settings composes workflows; the module that defines a policy also validates and updates it.
- Renderer-independent settings state is translated to Pi menus at the platform boundary.
- Persistence succeeds before a new effective setting becomes visible to consumers.

## Superseded

- Menu callbacks that implement policy or publish in-memory state before persistence are retired. The [UI state matrix](./ui-states.md) owns workflows; capability commands own decisions.

## Superseded (Phase 7 completion)

- The `open-legacy-category` effect and the ConfigStore-backed owner adapters are retired with the last monolithic menu. Every category is a native settings page; owners in `bootstrap/settings.ts` adapt the policy-owning capability directly.

## Implementation-only

- Page ids, row-id encodings, and the page stack are host-facing wiring, not public settings concepts.
