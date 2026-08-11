# Child screen decisions

## Current

- Product navigation and presentation state are renderer-independent.
- `platform/pi/tui` is the sole owner of Pi components, private-layout checks, focus wiring, and paint effects.
- Unknown layout or ownership conflict fails closed before partial mutation.

## Superseded

- Repaint, focus, footer, and Pi-version patch history is classified in [refactoring-history-audit.md](../../../../docs/refactoring-history-audit.md) until it is transferred to state examples and decisions.

## Implementation-only

- `AgentNavigator` method names and Pi component references are not public concepts.
