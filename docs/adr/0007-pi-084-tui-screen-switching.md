# Pi 0.84 shared-component TUI screen switching

## Status

Accepted.

## Context

Pi 0.84 changed the interactive TUI from the older flat root layout to seven
root components:

1. `documentContainer`
2. pending messages
3. status
4. widgets above the editor
5. editor
6. widgets below the editor
7. `footerContainer`

The document has exactly three children: header, loaded resources, and chat.
Fullscreen wraps that same `documentContainer` in a `ScrollView` and builds its
dock from direct references to the remaining root components. Runtime mode
switching replaces the renderer behind a stable TUI Proxy, clears the old
renderer, and remounts the same component objects on the new renderer.

Replacing root-array entries, as the Pi 0.83 implementation did, updates the
regular renderer but leaves fullscreen's ScrollView and dock holding stale
components. Pi 0.84 also keeps the footer container stable: `setFooter()`
replaces its child rather than the root component.

## Decision

The navigator supports only the verified Pi 0.84 layout. Before enabling a
Child screen it requires seven root components, three document children, chat
at document index 2, and the expected container relationships for editor and
below-editor selector placement. An unsupported layout fails closed with one
warning before any screen mutation.

Selecting a Subagent:

- replaces only `documentContainer.children[2]` with the child transcript;
- preserves pending, status, and footer container instances;
- temporarily replaces those containers' `render` methods with extension-owned
  functions;
- reads the footer container's current child on every render, so another
  extension may replace the footer while the Child screen is active;
- removes the first two rows only when the current child is Pi's built-in
  footer, preserving extension status rows and rendering custom footers intact.

Returning to Main or disposing restores chat and render methods only when the
current references are still the extension-owned replacements. A conflicting
chat or render replacement aborts activation rather than overwriting another
extension. `/reload` disposes the current runtime, restores Main, and clears
volatile child sessions and pins; persisted parent result entries remain under
the result-delivery policy.

## Consequences

- Regular and fullscreen mode switches preserve the selected Subagent,
  transcript, and input route because both renderers observe the same component
  instances.
- Dynamic custom footer replacement works in Main and Child screens without
  footer ownership or reconciliation state.
- The implementation is intentionally coupled to Pi 0.84's verified internal
  layout. A future layout change disables Child screen activation safely until
  the constants and tests are updated.
- Regression tests model the stable renderer Proxy, use Pi's real `ScrollView`
  and `VStack` components, verify dynamic footer replacement across mode
  switches, and assert atomic failure for malformed document layouts and
  conflicting render methods.

## Considered options

- **Replace root entries.** Rejected because fullscreen retains direct references
  to the original components.
- **Install a second child-only footer.** Rejected because it would compete with
  Pi and other extensions for footer ownership and miss dynamic replacements.
- **Support both Pi 0.83 and 0.84 layouts.** Rejected because the package now
  requires Pi 0.84.1 and maintaining two private-layout paths would increase the
  failure surface.
