# Repository instructions

This file is the repository-level execution guide and the single source of truth for agent instructions. It routes work to the documents that own product and architecture facts; it does not duplicate those facts.

## Read before changing code

- Before changing `src/modules/`, read the [architecture map](docs/architecture/index.md), [public test seams](docs/architecture/testing.md), and the target module's `docs/index.md`, `contracts.md`, `decisions.md`, and `testing.md`.
- Before changing `src/bootstrap/` or `src/platform/`, read the [cross-module architecture decisions](docs/architecture/decisions.md) and the documentation for every module whose public surface is involved.
- Before changing product behavior, read the relevant document under [product PRDs](docs/product/prd/index.md). Requirement IDs and acceptance tests must move together.
- Read the defensive entry point below before lifecycle, concurrency, cancellation, teardown, persistence, configuration, or TUI work.

## Repository map

```text
src/modules/      Product capabilities; each exposes one public.ts surface
src/platform/     Pi, filesystem, process, and TUI adapters
src/bootstrap/    Composition root, host registration, and capability wiring
docs/product/     Current user-visible requirements and acceptance criteria
docs/architecture/ Cross-module decisions, dependency rules, and test seams
test/             Public-seam, bootstrap, platform, and architecture tests
.agents/skills/   Reusable repository workflows shared by coding agents
```

Each capability under `src/modules/` may contain `contracts/`, `core/`, `application/`, `ports/`, and `docs/`. Internal layers use direct imports; consumers outside the module import only through its `public.ts`.

## Documentation ownership

- `README.md` owns user onboarding and a concise product-facing overview.
- `docs/product/prd/` owns current user-visible behavior and requirement IDs.
- `docs/architecture/decisions.md` owns cross-module architecture decisions; `docs/architecture/testing.md` owns public test seams.
- A module's `docs/contracts.md`, `decisions.md`, state/UI documents, and `testing.md` own that capability's obligations, rationale, state model, and verification strategy.
- `CONTEXT.md` owns domain vocabulary only; it does not own architecture rationale.
- Code comments and JSDoc own only local, non-obvious implementation obligations.
- `.agents/skills/` owns reusable agent workflows, not product or runtime contracts.
- `AGENTS.md` owns workflow, routing, and repository-wide engineering rules. `CLAUDE.md` only forwards to this file and shared workflows.

Keep one authoritative home for each fact. Other documents link to that authority instead of restating it. Update the owning document with every behavior or architecture change, and do not preserve superseded behavior as review history in current-state prose.

## Defensive change entry points

- Lifecycle, concurrency, cancellation, continuation, or teardown: read the [runtime state machine](src/modules/subagent-runtime/docs/state-machine.md), [runtime decisions](src/modules/subagent-runtime/docs/decisions.md), and [runtime testing strategy](src/modules/subagent-runtime/docs/testing.md).
- Background persistence, acknowledgement, or injection: read the [delivery state machine](src/modules/background-result-delivery/docs/state-machine.md), [delivery decisions](src/modules/background-result-delivery/docs/decisions.md), and persistence seam in [architecture testing](docs/architecture/testing.md).
- Child screen, navigation, focus, or TUI host behavior: read the [Child screen UI states](src/modules/child-screen/docs/ui-states.md), [Child screen decisions](src/modules/child-screen/docs/decisions.md), and UI seam in [architecture testing](docs/architecture/testing.md).
- Configuration paths, precedence, loading, or persistence: read the [configuration operations contract](src/modules/configuration/docs/operations.md) before changing code.
- Any cross-boundary change must define or update its TypeBox schema first and prove both a valid round trip and an invalid case at an approved public seam.

## S.U.P.E.R Architecture — Mandatory Coding Standard

> Write code like building with LEGO — each brick has a single job, a standard interface, a clear direction, runs anywhere, and can be swapped at will.

All code produced in this project MUST conform to these five principles. Violations are treated as bugs.

### S — Single Purpose

- Each module, file, and function solves exactly one problem
- Prefer decomposition; power comes from composition
- **Litmus test**: Can you describe this module's responsibility in a single sentence? If not, split it.

### U — Unidirectional Flow

- Data flows in one direction: input → processing → output
- Dependencies point inward: outer layers depend on inner, inner layers know nothing about outer
- No circular imports, no reverse dependencies
- **Litmus test**: Can the core logic run unit tests with zero external services?

### P — Ports over Implementation

- Define interface contracts (JSON Schema, types, data structures) BEFORE writing implementation
- All cross-module I/O must be serializable
- Swapping a data source, render layer, or notification channel requires zero changes to core logic
- **Practice**: Every module boundary communicates via explicit, schema-defined contracts

### E — Environment-Agnostic

- Configuration via environment variables or config files, never hardcoded
- All dependencies explicitly declared (requirements.txt / package.json / Cargo.toml)
- Processes are stateless; persistence delegated to external storage
- Logs to stdout. Same codebase runs locally, in Docker, on cloud
- **Config precedence**: Environment variables > .env > config file > in-code defaults

### R — Replaceable Parts

- Any layer can be replaced without affecting others
- Replacement cost is THE core metric of architecture quality
- If replacing one component triggers cascading changes, the architecture is broken
- **Validation**: For each module, ask "Can I swap this with a different implementation by only touching this module's directory?"

### S.U.P.E.R Code Review — Run After Every Task

Before marking any task as complete, verify ALL of the following:

| # | Check | Principle |
|:--|:------|:----------|
| 1 | Every new module/file has exactly one responsibility | S |
| 2 | No function does more than one conceptual thing | S |
| 3 | Data flows input → processing → output, no reverse deps | U |
| 4 | No circular imports introduced | U |
| 5 | Cross-module interfaces are schema-defined (types/contracts) | P |
| 6 | Module I/O is serializable | P |
| 7 | No hardcoded paths, URLs, keys, or config values | E |
| 8 | All new dependencies explicitly declared in dependency file | E |
| 9 | New modules can be replaced without changes to other modules | R |
| 10 | All tests pass after the change | — |

**Scoring**: All pass = proceed. 1-2 fail = fix before marking complete. 3+ fail = stop and refactor.

## Development and verification

**Package manager:** bun (`bun install`, `bun add`, `bun add -d`).

**Typecheck:** `bun run typecheck`.

**Tests:** `bun run test` is the official full suite and keeps `--maxWorkers=1` for CI stability. `bun run test:parallel` runs without that cap.

During implementation, run the narrowest approved public-seam tests that cover the change. Before pushing, force-pushing, marking work ready for review, or claiming checks pass, read and follow [pre-push-checks](.agents/skills/pre-push-checks/SKILL.md). Run selected evidence once for an unchanged tree; do not repeat it merely because a commit or push follows.

Before committing, run `git diff --cached --check`. Run the full suite locally only for an explicit user request, CI failure diagnosis, or a repository-wide change with no credible narrower evidence. The Test workflow owns mandatory full-suite execution on Linux and Windows for every push and pull request.

For local validation, "all tests" in the S.U.P.E.R. checklist means every test selected by `pre-push-checks`; CI owns the exhaustive repository suite.

**Worktrees:** When creating a worktree, link reusable dependency directories such as `node_modules` to the main checkout; do not copy, reinstall, or move the main checkout's `node_modules`. Keep the main checkout and worktree on the same filesystem side (both Windows or both WSL/Linux); do not cross-link Win<->WSL. **Windows:** `cmd /c mklink /J <worktree>/node_modules <main>/node_modules`; unlink with `cmd /c rmdir <worktree>/node_modules` (do not recursively delete a junction). **WSL/Linux:** `ln -s <main>/node_modules <worktree>/node_modules`; unlinking the symlink must remove only the link. After merge, unlink first, then remove the worktree and leftover branches.

## Language, code, and Git

- Agent responses use Simplified Chinese.
- Code comments, JSDoc, test names, test descriptions, assertion messages, commits, and PR descriptions use English.
- Comments explain why, trade-offs, failure boundaries, and revisit conditions; they do not restate visible control flow.
- Follow KISS: no unrequested compatibility layer, migration shim, duplicate implementation, speculative fallback, or scope expansion. Because releases exist, any persisted-format or public-contract break requires an explicit migration/version decision.
- Match surrounding naming, comment density, and idiom.
- Commits use English Conventional Commits. Non-trivial commits add concise `- ` bullets and never include AI attribution.
- After review fixes and required checks pass, add `Review-Result: PASS` to the commit message. That commit is the inclusive review checkpoint.

## Release

**Version source:** `package.json`. Release tags must be annotated and match it exactly as `v<version>`.

**Release notes:** Summarize final user-visible features and breaking changes. Fold intermediate fixes, tests, and superseded implementations into the feature they completed.

**Publishing:** `.github/workflows/publish.yml` runs only for pushed `v*` tags and publishes through npm Trusted Publishing. Do not run routine releases with a local `npm publish` or a long-lived `NPM_TOKEN`.

**Before tagging:** Ensure the release commit is on `origin/main`, the working tree is clean, the changelog is approved, and the normal Test workflow passes. The publish workflow rechecks the tag/version match, installs with the lockfile, runs typecheck and the full test suite, and performs an npm package dry run before publishing.

**Tagging:** `git tag -a v<version> -m "v<version>" && git push origin v<version>`. Never move or force-push a release tag. Rerun a failed workflow only when npm has not published that version; code fixes require a new version and tag.

**Trusted Publisher setup:** npm package settings must authorize GitHub Actions for owner `IIwate`, repository `pi-subagents-lite`, workflow `publish.yml`, and the `npm publish` action. The workflow uses GitHub-hosted runners with `id-token: write` and a pinned Trusted Publishing-compatible npm CLI; no npm token secret is required.
