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
| Full suite | 50 files, 856 passed, 2 skipped, 858 total | Vitest |
| Skipped tests | Two directory-symlink scenarios when the host returns `EPERM`/`EACCES` | Worktree fixture capability |
| Architecture guard | 6 tests passed | Source graph, documentation, and migration baselines |
| Markdown links and module docs | Pass | Scoped repository documentation |

The two skipped scenarios are not replaced by ordinary directories or junctions. Environments with directory-symlink capability execute the real symlink resolution and cross-repository tests.

## Dependency baseline

- Source TypeScript files: 62.
- Internal source edges: 205.
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

## Phase 1 tracer verification

- `REQ-CATALOGUE-002` is exercised through `agent-catalogue/public.ts` with a literal JSON command and result.
- Session-start discovery now uses the catalogue facade and the filesystem repository wired by `bootstrap`; the legacy `scanAndMerge` entry point was removed.
- `disableDefaultAgents` is read through `configuration/public.ts`, validated by the catalogue contract, and does not add a persisted section or revision field.
- `AcceptedRunPolicySchema` now validates the resolver's accepted-call snapshot; Agent configuration and invocation types derive from the Agent catalogue and runtime TypeBox contracts.
- The direct `src/agents/types.ts` to `src/types.ts` cycle was removed; the remaining cycle is unchanged migration debt.
- The tracer commits run `bun run typecheck`, focused contract tests, architecture guards, and the full suite before the Phase 1 review checkpoint.

## Phase 1 exit review

- The session-start Agent discovery behavior has one production path through `agent-catalogue/public.ts`; no parallel old discovery execution remains for that call site.
- The accepted Agent call snapshot is validated through `subagent-runtime/public.ts` before the spawn path consumes it.
- The direct contract cycle, configuration-shape drift, undocumented requirement references, and new internal mocks remain absent.
- The final Phase 1 review includes the architecture guard, typecheck, focused public-seam tests, and full suite recorded above.
