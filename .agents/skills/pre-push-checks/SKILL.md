---
name: pre-push-checks
description: Inspect a pi-subagents-lite branch and run the smallest credible local validation set before pushing, force-pushing, marking work ready for review, or claiming checks pass. Use again after a merge or rebase changes the base. CI owns the exhaustive Linux and Windows suite.
---

# Pre-push checks

Validate the behavior reached by the outgoing diff exactly once. Keep local feedback narrow; leave exhaustive cross-platform rehearsal to CI unless the change cannot be covered credibly by a smaller set.

## Inspect the outgoing change

1. Confirm the checkout and branch.

```sh
git status --short --branch
git rev-parse --show-toplevel
```

2. Verify the actual target branch or PR base and fetch that explicit ref when necessary. Never infer the base from the current branch name or assume its configured upstream is the PR base.

3. Require one merge base, then inspect every change layer.

```sh
git merge-base --all <verified-base-ref> HEAD
git diff --name-only <merge-base-sha> HEAD
git diff --cached --name-only
git diff --name-only
git ls-files --others --exclude-standard
```

Treat the first diff as committed scope. Treat staged, unstaged, and untracked paths as independent current-worktree scope. Reinspect after merging or rebasing because a new base can invalidate earlier evidence.

## Select relevant evidence

Use the approved [public test seams](../../../docs/architecture/testing.md). Choose tests by behavior and ownership, not by path matching alone.

- For a capability under `src/modules/<capability>/`, run its owning files under `test/modules/<capability>/`. Add affected bootstrap or platform tests when a public contract changes.
- For `src/platform/`, run the owning adapter tests under `test/platform/` plus the module contract tests implemented by that adapter.
- For `src/bootstrap/`, run the owning host-seam tests under `test/bootstrap/` plus affected module tests.
- For Child screen or Pi TUI behavior, run the affected `test/modules/child-screen/` and `test/platform/tui/` files.
- For Agent session behavior, run the affected `test/agents/` or `test/platform/pi/` files and the runtime contract tests whose events or snapshots change.
- For `README.md`, `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, product docs, architecture docs, module docs, or this skill, run:

```sh
bunx vitest run test/architecture/documentation-guards.test.ts --maxWorkers=1
```

- For schemas, `public.ts` surfaces, dependency direction, architecture guards, or PRD requirement IDs, add the relevant files under `test/architecture/`.
- For shared fixtures, `test/runtime-harness.ts`, test configuration, package metadata, TypeScript configuration, or changes spanning several capabilities, run every affected suite. Use the full suite when no narrower set is credible.

Run focused Vitest evidence with explicit files or directories:

```sh
bunx vitest run <owning-test-paths> --maxWorkers=1
```

Run `bun run typecheck` once for the unchanged outgoing tree. Check whitespace for both committed and dirty scope when present:

```sh
git diff --check <merge-base-sha> HEAD
git diff --cached --check
git diff --check
```

Do not treat a test discovered by import relationships as complete evidence for configuration, dynamic loading, persistence, host callbacks, or TUI behavior. Add the owning seam explicitly.

## Use the full suite deliberately

Run `bun run test` locally only when:

- the user explicitly requests a full run;
- a CI failure is being reproduced or diagnosed; or
- the diff is repository-wide enough that no narrower evidence set is credible.

The normal [Test workflow](../../../.github/workflows/test.yml) runs typecheck and the full suite on Linux and Windows for every push and pull request. Do not repeat a passing local check merely because a commit or push follows. If the tree or base changes, rerun only the evidence invalidated by that change.

## Handle failures and report evidence

- Stop before pushing when selected evidence fails. Fix the failure or report the exact blocker; do not assume CI will differ.
- Record the exact commands and outcomes. Say `relevant checks passed`, not `all checks passed`, unless the full suite actually ran.
- Never bypass a hook or use raw `--force`. A history rewrite requires explicit authorization and `--force-with-lease` against an observed remote ref.
- Do not push unless the current user request authorizes it.
