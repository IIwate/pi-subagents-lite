# Settings testing

## Primary seam

Test settings navigation, snapshots, delegation, and action results through `settings/public.ts`. Test Pi menu rendering through a narrow platform contract.

## Required scenarios

- Opening and navigating `/agents` without policy duplication.
- Delegating Model access, Thinking, concurrency, prompt mode, display, and debug updates.
- Quick model setup sharing the full model-access command semantics.
- Successful persistence and explicit persistence failure with no partial state.
- Inactive-limit management and future-call-only effect boundaries.

## Fixtures and doubles

Use in-memory owner facades and configuration ports. Do not mock internal settings modules or assert menu callback call order.
