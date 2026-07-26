# Dev
**Package manager:** bun (`bun install`, `bun add`, `bun add -d`)
**Typecheck:** `bun run typecheck`
**Windows local tests:** `bun run test` (excludes `test/linux/**`)
**Full/Linux CI tests:** `bun run test:ci`
**Before committing:** run typecheck and Windows local tests; GitHub Actions validates Linux-only assertions.
