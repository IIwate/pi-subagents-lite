# Child screen testing

## Primary seam

Test navigation commands and snapshots without Pi TUI. Test Pi behavior separately through a small renderer contract suite.

## Suite ownership

- `test/modules/child-screen/navigation.test.ts` — command decisions: selection, folding, key handling, clear confirmation, interaction request identity.
- `test/modules/child-screen/projection.test.ts` — list, footer status, and transcript snapshots with literal expectations.
- `test/platform/tui/layout.test.ts` — pure layout contracts: validation, swap, restoration, and child footer rendering.
- `test/platform/tui/child-screen-host.test.ts` — `ChildScreenHost` renderer contract: widget/status wiring, screen swap, footer preservation, fail-closed layouts, timers, editor interception.
- `test/platform/tui/paint.test.ts` — color-role to theme translation.

## Required scenarios

- Main/Child selection and return.
- Expanded/folded state, default preference, and current-runtime override.
- Running, queued, terminal, blocked, and empty states.
- Main's unfocused viewport includes the first Running row with correct top/bottom hidden counts, while an all-terminal list starts at the head; selected/highlighted rows retain their own centering.
- A selected stream updates on consecutive unchanged-signature ticks without `replace-records`, checks only that selected ID, and is cleared by a full finalized-message sync without duplication.
- Delimiter-bearing record fields trigger a second full sync rather than colliding in the refresh signature.
- `refresh-stream` rejects malformed JSON, ignores stale IDs without changing selection or the current overlay, and deep-copies the streaming message.
- Main/unselected ticks do not inspect transcript history, even with many records and long finalized histories.
- Regular/fullscreen switches, shrink clearing, footer replacement, ownership conflict, disposal, and reload.
- Outbound `execute()` results that fail `NavigatorCommandResultSchema` are refused as `invalid-command` rather than handed out.
- Invalid `debugFaultKind` and `pendingResultCount` payloads are rejected at the command seam and not copied onto the current snapshot.

## Fixtures and doubles

Use literal serialized snapshots and deterministic runtime events. Renderer contract tests build on the verified Pi 0.84 layout fixtures in `test/platform/tui/fixtures.ts`; do not mock navigator internals or Pi packages.
