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

Use plain JSON fragments and independent literals. Do not mock settings pages, runtime services, prompt assembly, or internal policy functions. Persistence is covered by the configuration module and its platform repository contract tests; the settings suite covers the owner verbs that commit fragment transitions.
