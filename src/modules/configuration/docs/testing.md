# Configuration support testing

## Primary seam

Test source resolution and fragment transactions through `configuration/public.ts` with plain JSON values.

The Phase 1 tracer reads a capability-owned value through that public surface and verifies that JSON round-tripping keeps the revision outside the three-section document.

## Required scenarios

- Environment > `.env` > persisted file > capability-owned defaults for operational settings.
- Interactive Model and Thinking policies are not implicitly overridden by environment values.
- Successful atomic replacement preserves unrelated sections and updates the in-memory revision.
- Failed replacement returns an explicit failure and leaves the prior snapshot unchanged.
- Malformed persisted data and unknown sections are handled according to the approved current-format contract.
- Load/save round trips preserve the current `modelRouting`, `agent`, and `concurrency` shape.

## Fixtures and doubles

Use an in-memory document repository for core tests. Filesystem, environment, and atomic-rename failures are covered by platform contract tests. Do not mock ConfigStore or capability modules.
