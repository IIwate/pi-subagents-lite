# Child screen

## User outcomes

Users can select a Subagent and inspect its transcript and status in the existing Child screen. The screen remains selected across Pi regular/fullscreen switches and returns control to Main without damaging other extension footers or Pi-owned components.

## Requirements

### REQ-CHILD-001 — Main and Child navigation

Selecting a Subagent activates its Child screen without changing its lifecycle. `Alt+M` returns to Main, and the selected Child remains stable across supported renderer mode switches.

### REQ-CHILD-002 — Expanded and folded presentation

The persisted display preference controls the initial list state for a new runtime. `Alt+A` controls folding for the current runtime thereafter. Expanded and folded views show the existing counts, labels, footer behavior, and interaction notices. With Main active and the list unfocused, the viewport follows the first Running record; without one, it starts at the first record. Child selection and keyboard focus retain their own row-centered behavior.

### REQ-CHILD-003 — Renderer safety

The Child screen replaces only the intended document region, preserves extension-owned footer content, and fails closed on unknown layouts or ownership conflicts before partial mutation.

### REQ-CHILD-004 — Lifecycle and failure presentation

Running, queued, terminal, blocked, and interaction-failure states render the existing local-only presentation. A selected Child refreshes only its current streaming message once per tick; full record synchronization owns stable transcript history and clears the stream overlay when the message finalizes. Main and unselected sessions incur no transcript inspection. Child interaction failures do not inject notices into Main's transcript.

## Out of scope

- A new renderer, color system, or visual redesign.
- A new status channel or external notification surface.

## Acceptance intent

Acceptance examples cover Main/Child transitions, default Running viewport, expanded/folded state, selected-stream refresh and finalization, zero-cost Main ticks, regular/fullscreen switching, shrink clearing, footer preservation, ownership conflicts, disposal, reload, and blocked interaction.
