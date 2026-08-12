# Child screen decisions

## Current

- Product navigation and presentation state are renderer-independent.
- `platform/pi/tui` is the sole owner of Pi components, private-layout checks, focus wiring, and paint effects.
- Unknown layout or ownership conflict fails closed before partial mutation.

## Superseded

- Renderer-owned navigation state and `LiveView`-specific repaint behavior are retired. The [UI state matrix](./ui-states.md) owns shrink, focus, footer, regular/fullscreen, teardown, and conflict examples.

## Implementation-only

- `AgentNavigator` method names and Pi component references are not public concepts.
