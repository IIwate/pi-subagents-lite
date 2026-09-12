# Development

[package.json](../package.json) defines supported runtimes and executable scripts. Install dependencies with `bun install`; use `bun add` or `bun add -d` to update them. Local verification follows the [root rules](../AGENTS.md#verification-and-test-standards).

## Commands

| Command | Scope |
|---|---|
| `bun run typecheck` | Production TypeScript. |
| `bun run typecheck:test` | Production code, all tests, shared fixtures, and Vitest configuration. |
| `bun run lint` | ESLint correctness rules for production code, tests, and Vitest configuration; zero warnings allowed. |
| `bun run test:unit` | Module invariants. |
| `bun run test:scenarios` | Cross-module and external resource scenarios. |
| `bun run test` | Official full suite, with both projects and at most four workers. |
| `bun run test:parallel` | Both projects without the four-worker cap. |
| `bun run test:watch --project unit` | Unit watch mode. |
| `npm run verify-notes` | Note structure, links, source references, TypeScript examples, and type equivalence. |

Pass a file or directory to a layer command for focused execution, for example `bun run test:unit test/unit/ui/delivery-selector.test.ts`.

[ESLint](../eslint.config.mjs) uses the recommended JavaScript and TypeScript correctness rules. TypeScript owns unused-symbol checks. Explicit `any` remains available for Pi adapters and test doubles whose host types are incomplete; lint does not impose formatting rules.

## Test layers

- [test/unit/](../test/unit/) verifies pure functions and individual module behavior with focused fixtures.
- [test/scenarios/](../test/scenarios/) exercises multiple production modules, filesystem operations, reloads, and real Pi sessions. Providers are offline; these scenarios do not exercise a physical terminal or a live model API.
- [test/support/](../test/support/) owns reusable fixtures. `createTestHarness` cleans up resources, asynchronous disposals, registries, mocks, and clocks; each fixture registers the resources it creates.

Choose a layer by the behavior and resources exercised, rather than file size or filename. The [testing Note](../.agents/notes/implemented/testing/2026-09-09-test-layers-and-scenario-harness.md) owns fixture design and the reasons for the split. [vitest.config.mts](../vitest.config.mts) selects disjoint projects, and [tsconfig.test.json](../tsconfig.test.json) includes tests and fixtures by directory.

The [Test workflow](../.github/workflows/test.yml) checks types, lint, and npm package contents, and runs both layers on Linux and Windows in normal order and with fixed-seed shuffling. Its matrix and seed live in the workflow. The [Verify Notes workflow](../.github/workflows/verify-notes.yml) checks documentation for main-branch updates and pull requests. The [Publish workflow](../.github/workflows/publish.yml) repeats the quality gates, including Notes, before publishing.

## Worktrees

Keep the main checkout and worktree on the same filesystem side: both Windows or both WSL/Linux. Link reusable dependency directories such as `node_modules` to the main checkout; do not copy, reinstall, move, or share them across Windows and WSL.

Create the dependency link after creating an authorized worktree. Replace the example paths with the actual checkout paths.

WSL/Linux:

```sh
ln -s /path/to/main/node_modules /path/to/worktree/node_modules
```

Windows, from Command Prompt:

```bat
mklink /J "C:\path\to\worktree\node_modules" "C:\path\to\main\node_modules"
```

Before removing a worktree, unlink its dependency directory without traversing the target. On WSL/Linux, remove only the symlink:

```sh
unlink /path/to/worktree/node_modules
```

On Windows, remove only the junction from Command Prompt; do not use recursive deletion:

```bat
rmdir "C:\path\to\worktree\node_modules"
```

After unlinking, remove the worktree and its leftover branch when their work has been merged. Perform Windows-side cleanup on Windows.
