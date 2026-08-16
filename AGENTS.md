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

# S.U.P.E.R Architecture Philosophy

> Write code like building with LEGO — each brick has a single job, a standard interface, a clear direction, runs anywhere, and can be swapped at will.

This document defines the architectural principles that guide all code written during the development phases of a Spec-Driven Develop workflow. Every agent executing tasks should internalize these principles.

---

## S — Single Purpose

From Unix philosophy.

- Each module, file, and function solves exactly one problem
- Prefer decomposition; power comes from composition
- One skill does one thing, one worker does one thing, one script does one thing

**Litmus test:** if you cannot describe a module's responsibility in a single sentence, it needs to be split.

**Anti-pattern:** a script that fetches data, computes metrics, renders charts, and sends notifications.

**Correct approach:**
```
fetch_data.py  -> data retrieval only, outputs JSON
compute.py     -> computation only, reads JSON writes JSON
render.py      -> rendering only, reads JSON generates HTML
notify.py      -> notification only, reads JSON calls webhook
```

---

## U — Unidirectional Flow

From Clean Architecture.

- Data always flows in one direction: input -> processing -> output
- Dependencies always point inward: outer layers depend on inner layers, inner layers know nothing about outer layers
- No reverse dependencies, no circular calls

**Layered model:**
```
+-------------------------------+
|  Infrastructure (API, DB, UI) |  <- outermost, replaceable at will
+-------------------------------+
|  Adapters (transform, format) |
+-------------------------------+
|  Core business (pure logic)   |  <- innermost, zero external deps
+-------------------------------+
```

**Litmus test:** can the core logic run unit tests with zero external services? If not, the dependency direction is wrong.

---

## P — Ports over Implementation

From Hexagonal Architecture.

- Define interface contracts (data structures, JSON Schema) before writing implementation
- Use intermediate formats (JSON files, standard data structures) to isolate upstream from downstream
- Swapping a data source, a rendering layer, or a notification channel requires zero changes to core logic

**Practices:**
1. Every module's input and output must be a serializable data structure
2. Module boundaries communicate via JSON files or standard data structures; in-process typed objects are fine, but cross-module interfaces must be serializable
3. Define explicit schemas — not "just read the code to figure out the format"

---

## E — Environment-Agnostic

From 12-Factor App.

- Configuration injected via environment variables or config files, never hardcoded
- All dependencies explicitly declared (requirements.txt / package.json), no implicit reliance on global system packages
- Processes are stateless; all persistence delegated to external storage
- Logs go to stdout, not to files
- Same codebase runs on local machine, Cloudflare Workers, VPS, Docker

**Configuration precedence (high to low):**
```
Environment variables > .env file > config.json > in-code defaults
```

**Checklist:**
- All API keys and webhook URLs read from environment variables?
- All dependencies explicitly declared in a dependency file?
- No hardcoded file path assumptions?
- Can a different machine run this code with zero modifications?

---

## R — Replaceable Parts

The natural consequence and ultimate goal of S + U + P + E.

- Any layer can be replaced without affecting others
- Replacement cost is the core metric of architecture quality
- If replacing one component triggers cascading changes in unrelated modules, the architecture is broken

**Replacement matrix:**
| Replacing          | Impact scope       | Correct approach                          |
|:-------------------|:-------------------|:------------------------------------------|
| Data source API    | Adapter layer only | Write new fetcher, output same JSON       |
| Frontend renderer  | Render layer only  | Read same JSON, swap render implementation|
| Notification channel| Notification layer | Swap webhook adapter                      |
| Deployment platform| Deploy config only | Change wrangler.toml or Dockerfile        |
| Programming language| Implementation only| JSON contracts unchanged, rewrite in any language |

---

## Quick Check Card

```
+------------------------------------------+
|         S.U.P.E.R Quick Check            |
|                                          |
|  S  Does this module do only one thing?  |
|  U  Is the data flow unidirectional?     |
|  P  Are inputs/outputs schema-defined?   |
|  E  Can it run in a different env?       |
|  R  Can you replace it without ripple?   |
|                                          |
|  All Yes -> Architecture healthy         |
|  1-2 No  -> Refactoring needed           |
|  3+ No   -> Technical debt alert         |
+------------------------------------------+
```

---

## S.U.P.E.R Code Review Checklist (10 checks)

Run this checklist after every task before marking it complete. This is the agent-canonical copy of the checklist also shown in the user-facing README; keep the two in sync.

| Check | Principle |
|:------|:----------|
| Every new module/file has exactly one responsibility | S |
| No function does more than one conceptual thing | S |
| Data flows input → processing → output, no reverse deps | U |
| No circular imports introduced | U |
| Cross-module interfaces are schema-defined | P |
| Module I/O is serializable | P |
| No hardcoded paths, URLs, keys, or config values | E |
| All new dependencies explicitly declared | E |
| New modules can be replaced without changes to others | R |
| All tests pass after the change | — |

**Scoring rule:** All pass = proceed. 1-2 fail = fix before marking complete. 3+ fail = stop and refactor.

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

## Release

**Version source:** `package.json`. Release tags must be annotated and match it exactly as `v<version>`.

**Release notes:** Summarize final user-visible features and breaking changes. Fold intermediate fixes, tests, and superseded implementations into the feature they completed.

**Publishing:** `.github/workflows/publish.yml` runs only for pushed `v*` tags and publishes through npm Trusted Publishing. Do not run routine releases with a local `npm publish` or a long-lived `NPM_TOKEN`.

**Before tagging:** Ensure the release commit is on `origin/main`, the working tree is clean, the changelog is approved, and the normal Test workflow passes. The publish workflow rechecks the tag/version match, installs with the lockfile, runs typecheck and the full test suite, and performs an npm package dry run before publishing.

**Tagging:** `git tag -a v<version> -m "v<version>" && git push origin v<version>`. Never move or force-push a release tag. Rerun a failed workflow only when npm has not published that version; code fixes require a new version and tag.

**Trusted Publisher setup:** npm package settings must authorize GitHub Actions for owner `IIwate`, repository `pi-subagents-lite`, workflow `publish.yml`, and the `npm publish` action. The workflow uses GitHub-hosted runners with `id-token: write` and a pinned Trusted Publishing-compatible npm CLI; no npm token secret is required.
