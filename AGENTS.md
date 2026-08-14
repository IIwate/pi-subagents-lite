# Dev
**Package manager:** bun (`bun install`, `bun add`, `bun add -d`)
**Typecheck:** `bun run typecheck`
**Tests:** `bun run test` (the full suite; `--maxWorkers=1` is a CI-stability choice and stays the official script). `bun run test:parallel` runs without that cap.
**Before committing:** run typecheck and the full test suite.

**Worktrees:** When creating a worktree, link reusable dependency directories such as `node_modules` to the main checkout; do not copy, reinstall, or move the main checkout's `node_modules`. Keep the main checkout and worktree on the same filesystem side (both Windows or both WSL/Linux); do not cross-link Win↔WSL. **Windows:** `cmd /c mklink /J <worktree>/node_modules <main>/node_modules`; unlink with `cmd /c rmdir <worktree>/node_modules` (do not Recurse-delete a junction). **WSL / Linux:** `ln -s <main>/node_modules <worktree>/node_modules`; unlink with `rm <worktree>/node_modules` (`rm` on a symlink only removes the link). After merge, unlink first, then remove the worktree and leftover branches.

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
