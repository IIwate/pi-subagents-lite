# Dev
**Package manager:** bun (`bun install`, `bun add`, `bun add -d`)
**Typecheck:** `bun run typecheck`
**Tests:** `bun run test` (the full suite; runs in CI via `test.yml`)
**Before committing:** run typecheck and the full test suite.

# Repository language and style

**Commits:** English Conventional Commits; add concise `-` bullets for non-trivial changes.

**Review checkpoint:** After review fixes and required checks pass, add one commit-message line: `Review-Result: PASS`. Treat that commit as the inclusive checkpoint; the next review starts after it.

**Comments and tests:** English only; explain why, tradeoffs, failure boundaries, and revisit conditions.
