# Child screen decisions

## Current

- Product navigation and presentation state are renderer-independent.
- `platform/pi/tui` is the sole owner of Pi components, private-layout checks, focus wiring, and paint effects.
- The expanded viewport does not reorder rows. When Main is active and the list is not focused, it centers the first Running row so old attention records cannot hide current work; without Running work it starts at the head. A selected Child or keyboard-highlighted row remains the viewport focus in its respective mode, and hidden counters preserve discoverability.
- Complete record replacement and selected-stream refresh are separate paths. Full sync owns stable history and clears the transient overlay; the one-second path checks only the selected session's current streaming message. Re-inspecting every transcript was rejected because list refresh cost would grow with both Agent count and history length.
- The host's full-sync refresh key serializes an ordered structured record projection with `JSON.stringify`, not delimiter-joined fields. This keeps refresh decisions collision-free for schema-valid IDs, descriptions, display names, and other strings containing punctuation.
- The host supports only the verified Pi 0.84 layout. ADR 0007 named seven root components; the code's actual set is `documentContainer`, `pendingContainer`, `statusContainer`, `widgetAbove`, `editorContainer`, `widgetBelow`, and `footerContainer`, plus three document children, chat at document index 2, and the expected editor and below-editor container relationships. Fullscreen wraps the same `documentContainer` and builds its dock from direct references to the other root components, so screen switching replaces only `documentContainer.children[2]` and preserves the pending, status, and footer container instances — both renderers observe the same objects, which is what keeps the selected child, transcript, and input route stable across regular/fullscreen switches.
- The footer container's current child is read on every render, so another extension may replace the footer while the Child screen is active; the built-in footer's first rows are trimmed only when the current child is Pi's own footer.
- Unknown layout or ownership conflict fails closed before partial mutation: restoration only overwrites references that are still the extension-owned replacements, and a conflicting chat or render replacement aborts activation instead of clobbering another extension. A future Pi layout change therefore disables Child screen activation safely until the constants and tests are updated — intentional coupling to a verified private layout, chosen over silently degrading on an unverified one.

## Superseded

- Renderer-owned navigation state and `LiveView`-specific repaint behavior are retired. The [UI state matrix](./ui-states.md) owns shrink, focus, footer, regular/fullscreen, teardown, and conflict examples.
- A selected transcript that refreshed only when list fields changed is retired; long assistant messages otherwise remained frozen until `message_end`.
- Replacing renderer root-array entries (the Pi 0.83 approach) is retired: fullscreen retains direct references to the original components, so root replacement left its ScrollView and dock holding stale objects.
- A second child-only footer was rejected because it would compete with Pi and other extensions for footer ownership and miss dynamic replacements; supporting both Pi 0.83 and 0.84 layouts was rejected because the package requires Pi 0.84.1 and two private-layout paths double the failure surface.

## Implementation-only

- `AgentNavigator` method names and Pi component references are not public concepts. The host lives in `platform/pi/tui`.
