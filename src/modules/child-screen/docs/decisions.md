# Child screen decisions

## Current

- Product navigation and presentation state are renderer-independent.
- `platform/pi/tui` is the sole owner of Pi components, private-layout checks, focus wiring, and paint effects.
- The host supports only the verified Pi 0.84 layout: seven root components, three document children, chat at document index 2, and the expected editor and below-editor container relationships. Fullscreen wraps the same `documentContainer` and builds its dock from direct references to the other root components, so screen switching replaces only `documentContainer.children[2]` and preserves the pending, status, and footer container instances — both renderers observe the same objects, which is what keeps the selected child, transcript, and input route stable across regular/fullscreen switches.
- The footer container's current child is read on every render, so another extension may replace the footer while the Child screen is active; the built-in footer's first rows are trimmed only when the current child is Pi's own footer.
- Unknown layout or ownership conflict fails closed before partial mutation: restoration only overwrites references that are still the extension-owned replacements, and a conflicting chat or render replacement aborts activation instead of clobbering another extension. A future Pi layout change therefore disables Child screen activation safely until the constants and tests are updated — intentional coupling to a verified private layout, chosen over silently degrading on an unverified one.

## Superseded

- Renderer-owned navigation state and `LiveView`-specific repaint behavior are retired. The [UI state matrix](./ui-states.md) owns shrink, focus, footer, regular/fullscreen, teardown, and conflict examples.
- Replacing renderer root-array entries (the Pi 0.83 approach) is retired: fullscreen retains direct references to the original components, so root replacement left its ScrollView and dock holding stale objects.
- A second child-only footer was rejected because it would compete with Pi and other extensions for footer ownership and miss dynamic replacements; supporting both Pi 0.83 and 0.84 layouts was rejected because the package requires Pi 0.84.1 and two private-layout paths double the failure surface.

## Implementation-only

- `AgentNavigator` method names and Pi component references are not public concepts. The host lives in `platform/pi/tui`.
