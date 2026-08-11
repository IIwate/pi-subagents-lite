# Model access testing

## Primary seam

Test authorization commands and effective policy snapshots through `model-access/public.ts` with plain JSON inputs.

## Required scenarios

- Fresh Parent-only installation.
- Parent denial, implicit omission, and explicit exact-parent selection.
- Provider and Agent/model allowlists, All models, Selected models, dormant rules, and unavailable models.
- Pi availability versus Model catalogue and Model scope.
- Scope-pinned Thinking and exact saved Thinking overrides.
- Quick model setup atomicity and persistence failure.
- A running or queued Accepted run policy remaining unchanged after later updates.

## Fixtures and doubles

Use in-memory availability, scope, and configuration ports. Do not mock settings menus, runtime services, prompt assembly, or internal policy functions.
