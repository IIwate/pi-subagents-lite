# Child screen testing

## Primary seam

Test navigation commands and snapshots without Pi TUI. Test Pi behavior separately through a small renderer contract suite.

## Required scenarios

- Main/Child selection and return.
- Expanded/folded state, default preference, and current-runtime override.
- Running, queued, terminal, blocked, and empty states.
- Regular/fullscreen switches, shrink clearing, footer replacement, ownership conflict, disposal, and reload.

## Fixtures and doubles

Use literal serialized snapshots and deterministic runtime events. Mock only the renderer port in application tests; do not mock navigator internals.
