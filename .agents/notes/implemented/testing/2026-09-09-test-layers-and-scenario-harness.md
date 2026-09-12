# Agent Note: Test layers and scenario resource ownership

Status: implemented

## Problem

Pure delivery formatting, selector navigation, and manager/coordinator lifecycle scenarios share setup in feature-sized test files. Changing a scenario fixture can break unrelated unit assertions. A file whitelist in the test TypeScript configuration leaves other tests outside the compiler contract, and documentation links couple verification instructions to that accidental layout.

## Decision

- Module invariants live under [test/unit](../../../../test/unit/). Cross-module, filesystem, reload, and real Pi session checks live under [test/scenarios](../../../../test/scenarios/). The boundary exercised determines placement; file length and `describe` nesting do not define a layer. Mixed delivery, discovery, skill, and UI assertions reside with the module they verify.
- [test/support](../../../../test/support/) contains configuration, catalogue instances, resource disposal, and focused module fixtures. `createTestHarness` owns temporary directories, asynchronous disposal, mocks, and clocks. Runtime scenarios use official parent sessions, offline providers, and native session files. The delivery adapter verifies receipts in the real parent log; memory-only publication is not an acknowledgement.
- Offline provider fixtures supply responses and failures to the real Pi agent loop; rendering tests supply navigation snapshots. Scheduling, retries, and delivery follow the production paths. Fixture gates control when a provider response becomes available and release during teardown. [Runtime scenarios](../../../../test/scenarios/runtime.test.ts) verify failure, explicit continuation, and the resulting durable output.
- [vitest.config.mts](../../../../vitest.config.mts) defines disjoint projects named `unit` and `scenarios`. `bun run test:unit` and `bun run test:scenarios` select one layer; `bun run test` includes both. Scenarios run offline and do not provide physical terminal or live provider coverage.
- [tsconfig.test.json](../../../../tsconfig.test.json) includes every test and fixture through `test/**/*.ts`, plus production code and Vitest configuration. Active Notes link to the responsible test layer. The relative-link gate checks targets throughout the repository, including test files. CI checks both layers in normal and fixed-seed shuffled runs on Linux and Windows; publishing checks their types and runs the full suite.
- [ESLint](../../../../eslint.config.mjs) applies recommended correctness rules to production code, tests, and Vitest configuration with zero warnings allowed. TypeScript owns unused-symbol checks. Host adapters and test doubles retain explicit `any`, setup callbacks retain forward declarations, and terminal protocol code and its tests permit control-character regexes. These exceptions preserve their respective runtime and verification boundaries.

## Alternatives considered

- **Keep the existing layout and execution command.** This avoids import churn and preserves established workflows, but leaves mixed setup and the compiler whitelist intact, so it cannot provide an isolated daily unit layer.
- **Classify by filename suffix or a line-count threshold.** This minimizes moves and is easy to automate, but sends pure assertions into the slow layer and leaves multi-module scenarios mislabeled when their names or sizes differ.
- **Convert every scenario into isolated mocks.** This offers short execution and local failures, but cannot prove Pi retry behavior, durable writes, or lifecycle composition. These boundaries retain focused integration scenarios with explicit resource ownership.

## Evidence

`cba0940` and `636307e` establish concern-aligned test layout; `4edb1d6`, `7316eb5` and `574737c` record fixture reuse and tests at observable boundaries. `df1d5e6` and `0272b4f` address serialized overhead, isolated resources and parallel execution. `5dff016`, `d9b0cb3` and `c7d3c80` record Windows/Linux assumptions, cross-platform fixtures, and the current unit/scenario projects. The executable documentation gates have their own [process Note](../process/2026-09-10-note-verification-boundaries.md).

## Verification

- `bun run typecheck` and `bun run typecheck:test` check production, tests, fixtures, and project configuration.
- `bun run lint` checks the configured correctness rules with `--max-warnings 0`.
- `bun run test:unit` covers module invariants; `bun run test:scenarios` covers composition and external resource boundaries. `bun run test --sequence.shuffle --sequence.seed=73021` exercises both layers with shuffled collection and execution.
- `npm run verify-notes` checks Note structure, repository-relative links, source anchors, document code, and type equivalence.
- [note-links.test.ts](../../../../test/scenarios/notes/note-links.test.ts) exercises a missing test-file link and its valid replacement against the actual tree gate.

## Consequences

Local changes have a dedicated unit command while CI retains the complete regression surface. Test additions receive compiler coverage by directory rather than registration in a whitelist. Scenario fixtures still carry setup cost and require explicit lifecycle ownership; introducing external provider or terminal coverage requires revisiting their offline contract. Tests that acquire real resources or join multiple production lifecycles belong in scenarios even when they are short. Module fixtures remain narrow rather than defining a general-purpose scenario language.
