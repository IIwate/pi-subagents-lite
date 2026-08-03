# Dev
**Package manager:** bun (`bun install`, `bun add`, `bun add -d`)
**Typecheck:** `bun run typecheck`
**Tests:** `bun run test` (the full suite; runs in CI via `test.yml`)
**Before committing:** run typecheck and the full test suite.

# Repository language and style

**Commits:** English Conventional Commits; add concise `-` bullets for non-trivial changes.

**Review checkpoint:** After review fixes and required checks pass, add one commit-message line: `Review-Result: PASS`. Treat that commit as the inclusive checkpoint; the next review starts after it.

**Comments and tests:** English only; explain why, tradeoffs, failure boundaries, and revisit conditions.

# Release

**Version source:** `package.json`. Release tags must be annotated and match it exactly as `v<version>`.

**Release notes:** Summarize final user-visible features and breaking changes. Fold intermediate fixes, tests, and superseded implementations into the feature they completed.

**Publishing:** `.github/workflows/publish.yml` runs only for pushed `v*` tags and publishes through npm Trusted Publishing. Do not run routine releases with a local `npm publish` or a long-lived `NPM_TOKEN`.

**Before tagging:** ensure the release commit is on `origin/main`, the working tree is clean, the changelog is approved, and the normal Test workflow passes. The publish workflow rechecks the tag/version match, installs with the lockfile, runs typecheck and the full test suite, and performs an npm package dry run before publishing.

**Tagging:** `git tag -a v<version> -m "v<version>" && git push origin v<version>`. Never move or force-push a release tag. Rerun a failed workflow only when npm has not published that version; code fixes require a new version and tag.

**Trusted Publisher setup:** npm package settings must authorize GitHub Actions for owner `IIwate`, repository `pi-subagents-lite`, workflow `publish.yml`, and the `npm publish` action. The workflow uses GitHub-hosted runners with `id-token: write` and a pinned Trusted Publishing-compatible npm CLI; no npm token secret is required.
