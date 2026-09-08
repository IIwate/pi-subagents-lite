# Development and verification

**Package manager:** bun (`bun install`, `bun add`, `bun add -d`).

**Typecheck:** `bun run typecheck` for production code; `bun run typecheck:test` for governed tests and shared fixtures.

**Tests:** `bun run test` is the official full suite and uses `--maxWorkers=4`. `bun run test:parallel` runs without that cap. CI checks normal and fixed-seed shuffled execution on Linux and Windows.

During implementation, run the narrowest tests that cover the change. Run selected evidence once for an unchanged tree; do not repeat it merely because a commit or push follows.

Before committing, run `git diff --cached --check`. Run the full suite locally only for an explicit user request, CI failure diagnosis, or a repository-wide change with no credible narrower evidence. The Test workflow owns mandatory full-suite execution on Linux and Windows for every push and pull request.

**Worktrees:** When creating a worktree, link reusable dependency directories such as `node_modules` to the main checkout; do not copy, reinstall, or move the main checkout's `node_modules`. Keep the main checkout and worktree on the same filesystem side (both Windows or both WSL/Linux); do not cross-link Win<->WSL. **Windows:** `cmd /c mklink /J <worktree>/node_modules <main>/node_modules`; unlink with `cmd /c rmdir <worktree>/node_modules` (do not recursively delete a junction). **WSL/Linux:** `ln -s <main>/node_modules <worktree>/node_modules`; unlinking the symlink must remove only the link. After merge, unlink first, then remove the worktree and leftover branches.

# Language, code, and Git

- Agent responses use Simplified Chinese.
- Code comments, JSDoc, test names, test descriptions, assertion messages, commits, and PR descriptions use English.
- Comments explain why, trade-offs, failure boundaries, and revisit conditions; they do not restate visible control flow.
- Follow KISS: no unrequested compatibility layer, migration shim, duplicate implementation, speculative fallback, or scope expansion. Because releases exist, any persisted-format or public-contract break requires an explicit migration/version decision.
- Match surrounding naming, comment density, and idiom.
- Commits use English Conventional Commits. Non-trivial commits add concise `- ` bullets and never include AI attribution.

# Release

**Version source:** `package.json`. Release tags must be annotated and match it exactly as `v<version>`.

**Release notes:** Summarize final user-visible features and breaking changes. Fold intermediate fixes, tests, and superseded implementations into the feature they completed.

**Publishing:** `.github/workflows/publish.yml` runs only for pushed `v*` tags and publishes through npm Trusted Publishing. Do not run routine releases with a local `npm publish` or a long-lived `NPM_TOKEN`.

**Before tagging:** ensure the release commit is on `origin/main`, the working tree is clean, the changelog is approved, and the normal Test workflow passes. The publish workflow rechecks the tag/version match, installs with the lockfile, runs typecheck and the full test suite, and performs an npm package dry run before publishing.

**Tagging:** `git tag -a v<version> -m "v<version>" && git push origin v<version>`. Never move or force-push a release tag. Rerun a failed workflow only when npm has not published that version; code fixes require a new version and tag.

**Trusted Publisher setup:** npm package settings must authorize GitHub Actions for owner `IIwate`, repository `pi-subagents-lite`, workflow `publish.yml`, and the `npm publish` action. The workflow uses GitHub-hosted runners with `id-token: write` and a pinned Trusted Publishing-compatible npm CLI; no npm token secret is required.
