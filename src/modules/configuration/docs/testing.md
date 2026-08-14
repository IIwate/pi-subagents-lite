# Configuration support testing

## Primary seam

Test source resolution and fragment transactions through `configuration/public.ts` with plain JSON values. The public seam suite lives in `test/modules/configuration/configuration.test.ts`; the file repository and path policy are covered by `test/platform/fs/configuration-repository.test.ts`.

## Required scenarios

- Environment > `.env` > persisted file > capability-owned defaults for operational settings.
- Interactive Model and Thinking policies are not implicitly overridden by environment values.
- Successful fragment commits preserve sibling keys and unrelated sections and advance the in-memory revision, which never appears in the document.
- Failed persistence returns an explicit failure and leaves the prior snapshot effective; stale revisions are rejected before writing.
- Malformed persisted data and unknown sections are handled according to the approved current-format contract.
- Outbound `execute()` results that fail `ConfigurationResultSchema` are refused as `invalid-command` rather than handed out.
- Load/save round trips preserve the current `modelRouting`, `agent`, and `concurrency` shape.

## Fixtures and doubles

Use an in-memory document repository for core tests. Filesystem, environment, and atomic-rename failures are covered by platform contract tests. Do not mock capability modules.
