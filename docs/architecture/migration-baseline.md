# Migration baseline

This is the measured Phase 0 starting point for the `re` branch. It is an implementation migration record, not a product requirement. The values must be updated only when a migration slice removes a baseline item or when the verification environment changes.

## Verification environment

- Host: Windows 11.
- Package manager: Bun.
- Typecheck: `bun run typecheck`.
- Full suite: `bun run test`.
- Test runner: Vitest with one worker.

## Current verification

| Check | Result | Boundary |
|:--|:--|:--|
| Typecheck | Pass | TypeScript compiler |
| Full suite | 56 files, 869 passed | Vitest |
| Skipped tests | None on this host. Two directory-symlink scenarios still skip when the host returns `EPERM`/`EACCES` | Worktree fixture capability |
| Architecture guard | 9 tests passed | Source graph, documentation, and migration baselines |
| Markdown links and module docs | Pass | Scoped repository documentation |

The two skipped scenarios are not replaced by ordinary directories or junctions. Environments with directory-symlink capability execute the real symlink resolution and cross-repository tests.

## Dependency baseline

- Source TypeScript files: 62.
- Internal source edges: 196.
- Existing strongly connected components: 1.
- The remaining allowed cycle fingerprint is recorded in `test/architecture/architecture-baseline.test.ts`.
- Existing internal `vi.mock` baseline: 27 test files, 69 calls.
- New internal mocks and new cycles fail the architecture guard immediately.

The allowed cycle and mock entries are migration debt. The first Agent catalogue tracer removed the direct `agents/types.ts` and `types.ts` cycle. A migration slice removes a resolved entry in the same change; no slice may add a new baseline entry without an approved architecture decision.

## Approved seams

1. Application facade: serialized command in, serialized result and events out.
2. Host seam: Pi Agent, StopAgent, and AgentStatus registration through the Pi platform harness.
3. UI seam: renderer-independent Child screen and settings snapshots, plus a small Pi renderer contract.
4. Persistence seam: repository contract for load, save, append, acknowledge, malformed input, and atomic failure.

Tests at these seams use public behavior and independent expected values. Internal collaborators, private methods, maps, and call order are not test interfaces.

## Phase 0 exit conditions

- The baseline values above are reproducible on the supported verification environments.
- No new cycle, inward-to-outward import, internal module mock, or undocumented requirement reference is introduced.
- README and product docs no longer contradict the approved Model access and Thinking behavior.

The first migration slice is a Phase 1 entry condition, not a Phase 0 implementation requirement: it must have one documented requirement, one TypeBox contract, one failing public-seam test, and one removed legacy path.

## History finding ownership

The history audit is frozen planning evidence, not a maintenance backlog. Each actionable consequence has one final owner:

| Actionable consequence | Final owner |
|:--|:--|
| Renderer-independent navigation and presentation states | [Child screen UI states](../../src/modules/child-screen/docs/ui-states.md) |
| Pi layout, focus, footer, paint, conflict, and teardown ownership | [Child screen decisions](../../src/modules/child-screen/docs/decisions.md) |
| Parent, Provider, model, availability, scope, saved-rule, and Thinking combinations | [Model access decision tables](../../src/modules/model-access/docs/decision-tables.md) |
| One effective Model access policy for runtime, prompt, and settings projections | [Model access decisions](../../src/modules/model-access/docs/decisions.md) |
| Delivery eligibility, wake, failure, restoration, and acknowledgement transitions | [Background delivery state machine](../../src/modules/background-result-delivery/docs/state-machine.md) |
| Separation of result persistence and parent messaging | [Background delivery contracts](../../src/modules/background-result-delivery/docs/contracts.md) |
| Delivery branch, failure, reload, `/tree`, read, and atomic-failure examples | [Background delivery testing](../../src/modules/background-result-delivery/docs/testing.md) |
| Retired special failure-retention states and implementation ownership | [Subagent runtime decisions](../../src/modules/subagent-runtime/docs/decisions.md) |
| Retention, pinning, selection, continuation, expiry, and close time semantics | [Subagent runtime state machine](../../src/modules/subagent-runtime/docs/state-machine.md) |
| Serializable lifecycle versus live Pi session ownership | [Subagent runtime contracts](../../src/modules/subagent-runtime/docs/contracts.md) |
| Setup, provider, abort, timeout, close, and late-event regression examples | [Subagent runtime testing](../../src/modules/subagent-runtime/docs/testing.md) |
| Agent guidance and Subagent prompt ownership without a user-facing inspection feature | [Prompt decisions](../../src/modules/prompt/docs/decisions.md) |
| Prompt fragments, inputs, ordering, determinism, and owning tests | [Prompt source inventory](../../src/modules/prompt/docs/prompt-sources.md) |
| Public test seams and architecture debt baselines | [Migration baseline](./migration-baseline.md#approved-seams) |
| Single-owner documentation and audit retirement policy | [Refactoring plan](../refactoring-plan.md#documentation-baseline-gate) |

The audit remains available only to explain how these risks were discovered and is retired in Phase 9 with the other migration-only evidence.

## Phase 1 tracer verification

- `REQ-CATALOGUE-002` is exercised through `agent-catalogue/public.ts` with a literal JSON command and result.
- Session-start discovery now uses the catalogue facade and the filesystem repository wired by `bootstrap`; the legacy `scanAndMerge` entry point was removed.
- `disableDefaultAgents` is read through `configuration/public.ts`, validated by the catalogue contract, and does not add a persisted section or revision field.
- `AcceptedRunPolicySchema` validates the complete accepted-call snapshot; Agent configuration and invocation types derive from the Agent catalogue and runtime TypeBox contracts.
- The runtime receives one validated JSON copy containing model, parent model, scope, Thinking, output, turn, and grace limits. Scheduling derives its concurrency key from that accepted model snapshot; callers cannot provide a parallel model key.
- The filesystem catalogue adapter isolates malformed definitions before returning its schema-valid result, preserving valid definitions in the same request.
- The architecture guard enforces the full inward matrix inside each capability module, including ports, and requires every module-external consumer to use the target module's `public.ts`.
- The direct `src/agents/types.ts` to `src/types.ts` cycle was removed; the remaining cycle is unchanged migration debt.
- Formal review of `46728e2..50c89c1` found no unresolved issues. Recorded verification: `bun run typecheck` pass; `bun run test` 50 files, 866 passed; architecture guard 9 passed; `git diff --check` pass.

## Phase 1 exit review

- The session-start Agent discovery behavior has one production path through `agent-catalogue/public.ts`; no parallel old discovery execution remains for that call site.
- The accepted Agent call snapshot is validated through `subagent-runtime/public.ts` before the spawn path consumes it.
- The direct contract cycle, configuration-shape drift, undocumented requirement references, and new internal mocks remain absent.
- The Phase 1 checkpoint records `Review-Result: PASS` after the review and the verification results above.

## Phase 2 verification

- Formal review of `8827566..fe60ce3` found no unresolved blocking issues after the review-fix commit.
- Agent discovery, merge, loading policy, and Model access authorize/update/query enter through module `public.ts`.
- Frontmatter scanning lives in `platform/fs`. Config load parses `modelRouting` through `parseModelAccessFragment`.
- Recorded verification: `bun run typecheck` pass; `bun run test` 56 files, 869 passed; architecture guard 9 passed; `git diff --check` pass.

## Phase 2 exit review

- Catalogue discovery and Model access policy tests do not require Pi, filesystem, menu, or runtime mocks.
- The Agent tool validates input, calls public use cases, and formats output.
- Catalogue and Model access policy no longer live in configuration normalizers, menus, `AgentManager`, or tool execution.
- The Phase 2 checkpoint records `Review-Result: PASS` after the review and the verification results above.
