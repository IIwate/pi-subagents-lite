# Dev
**Package manager:** bun (`bun install`, `bun add`, `bun add -d`)
**Typecheck:** `bun run typecheck`
**Windows local tests:** `bun run test` (排除 `test/linux/**`)
**Full/Linux CI tests:** `bun run test:ci`
**Before committing:** run typecheck and Windows local tests; Linux-only assertions 由 GitHub Actions 验收。
