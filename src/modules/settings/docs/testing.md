# Settings testing

## Primary seam

Test settings navigation, snapshots, delegation, and action results through `settings/public.ts` with plain JSON values and in-memory owners (`test/modules/settings/settings.test.ts`). Test Pi menu rendering through the narrow renderer contract in `test/platform/tui/settings-screen.test.ts` and the shared chrome in `test/platform/tui/settings-chrome.test.ts`.

## Required scenarios

- Opening and navigating `/agents` without policy duplication.
- Delegating Model access, Thinking, concurrency, prompt mode, display, and debug updates.
- Quick model setup sharing the full model-access command semantics.
- Successful persistence and explicit persistence failure with no partial state.
- Inactive-limit management and future-call-only effect boundaries.
- Numeric input validation (digits-only, minimum bound) rejecting host garbage before the owner is called.
- Conditional actions (create prompt file) appearing only while actionable and reporting explicit failure.

## Fixtures and doubles

Use in-memory owner facades and configuration ports. Do not mock internal settings modules or assert menu callback call order.
