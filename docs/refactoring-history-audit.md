# Refactoring history audit

## Purpose

This audit identifies repeated change and patch patterns that are easy to miss when reviewing only the surviving code. It is a temporary anti-survivor-bias ledger for the S.U.P.E.R. refactoring plan, not a source of product requirements, domain language, or final architecture rules.

## Lifecycle

This file is frozen planning evidence. Phase 0 used it to classify historical behavior as Current, Superseded, or Implementation-only and prevent repeated patches from disappearing from consideration. The final owner mapping now lives in [migration-baseline.md](./architecture/migration-baseline.md#history-finding-ownership); this audit is neither a product requirement nor a maintenance backlog.

- user outcomes and behavior belong in the PRD and acceptance examples;
- boundary rationale belongs in the owning module's `docs/decisions.md`;
- failure scenarios and regression seams belong in `docs/testing.md` or the relevant state machine;
- cross-module trade-offs belong in `docs/architecture/decisions.md`.

Do not copy this ledger wholesale into those documents. Once every finding has a final owner and all links and tests are verified, retire this file in Phase 9. The final project must not depend on a separate historical audit that future contributors could mistake for a second requirements backlog.

The primary sample is every commit authored as `IIwate <2450644621@qq.com>` across all local branches through commit `37162c8`. Current `CONTEXT.md`, README, ADRs, tests, and `tasks/lessons.md` are used to determine whether earlier behavior survived or was superseded.

## Author baseline

The sample contains 95 commits from 2026-07-24 through 2026-08-11:

| Commit type | Count |
|:--|--:|
| `fix` | 35 |
| `feat` | 21 |
| `refactor` | 12 |
| `docs` | 12 |
| `test` | 8 |
| `chore` | 5 |
| `style` | 1 |
| `ci` | 1 |

The counts do not prove poor quality. Their concentration identifies capabilities whose boundaries or requirements changed repeatedly.

## Hotspots

Churn is additions plus deletions from author-scoped `git log --numstat`; touches count commits that changed the path.

| Current path | Touches | Churn | Historical signal |
|:--|--:|--:|:--|
| `src/ui/agent-navigator.ts` | 36 | 1,722 | Product navigation, Pi rendering, focus, timers, transcript projection, and cleanup effects changed together |
| `test/ui/agent-navigator.test.ts` | 35 | 1,733 | Tests followed private UI structure nearly one-for-one |
| `src/agents/agent-manager.ts` | 30 | 1,307 | Scheduling, lifetime, shutdown, recovery, pinning, usage, and delivery ownership overlapped |
| `test/agents/agent-manager.test.ts` | 27 | 1,796 | Test churn exceeded production churn and often exercised manager internals |
| `src/agents/agent-runner.ts` | 18 | 670 | Pi session setup, prompt composition, retries, resources, and execution changed together |
| `test/agents/agent-runner.test.ts` | 20 | 1,625 | Large mocked session surface amplified adapter changes |
| `src/spawn/spawn-coordinator.ts` | 12 | 791 | Spawn and background delivery shared lifecycle and Pi messaging state |
| `test/spawn/spawn-coordinator.test.ts` | 11 | 1,657 | Delivery scenarios required broad coordinator fixtures |
| `src/ui/menu/menu-model-routing.ts` | 8 | 2,399 | Domain policy and menu workflow were repeatedly redesigned in the same file |
| `test/ui/menu/menu-model-routing.test.ts` | 7 | 2,175 | Policy changes forced large renderer-coupled test rewrites |
| `src/config/config-store.ts` | 16 | 780 | Persistence, policy mutation, and manager/navigator side effects shared ownership |
| `README.md` | 35 | 828 | User documentation repeatedly caught up with implementation changes |
| `CONTEXT.md` | 30 | 306 | Product language and boundaries were often stabilized after code landed |

## Change clusters

### UI state and Pi TUI effects

The UI path changed from list-first silent progress to repaint fixes, removal of `LiveView`, native shrink clearing, final-row reflow, collapsible navigation, simplified status surfaces, flattened settings navigation, and Pi 0.84 document/dock support.

Representative commits:

- `ad49767`: introduced list-first silent progress and forced reflow behavior.
- `615cb8a`: fixed interrupt pass-through and shrinking-list repaint.
- `87ddb0f`: removed `LiveView` and stabilized list updates.
- `dbb4de1` and `8da2e96`: fixed blank rows and final-removal reflow.
- `b72906d` and `74a1042`: added collapsible navigation and then simplified overlapping status surfaces.
- `65d1690`: rewrote the renderer integration for Pi 0.84.1.

Finding: some churn was intentional UX evolution, but repeated repaint, focus, teardown, and compatibility patches came from combining renderer-independent product state with Pi component mutation and lifecycle side effects.

Required response:

- `child-screen` owns commands, state transitions, and view snapshots.
- `settings` owns menu workflow and delegates policy decisions.
- `platform/pi/tui` alone owns Pi components, private layout checks, focus wiring, and paint effects.
- The PRD defines a UI state matrix before implementation; view snapshots and a small Pi contract suite cover it.

### Model access policy

Eight commits changed the current Model routing menu, producing 2,399 lines of churn. The product model moved from switch/allowlist/assignment precedence to locked enqueue choices, then to Provider and Agent access policy, Pi availability, dormant rules, simplified interactions, concrete Agent guidance, and finally configurable Parent model and Thinking access.

Representative commits:

- `02a536c`: introduced switch, Provider allowlist, Agent assignments, precedence, migration, and queue revalidation.
- `5b71727`: removed migration, locked models at enqueue, and expanded ConfigStore ownership.
- `aa5e867`: replaced assignments with access policy across 51 files.
- `b086a53`, `4b43733`, and `6e6b1b5`: refined availability, dormant rules, scope, Provider exceptions, and menu interaction.
- `fe27759`: fixed Agent guidance to advertise concrete callable keys.
- `cd5b143`: added configurable Parent model and exact-model Thinking access.

Finding: the central cause was an evolving domain model implemented simultaneously in persistence, runtime authorization, queue behavior, guidance, and menu state. Each consumer developed its own projection before the terminology and truth table settled.

Required response:

- The Model access PRD contains complete authorization and Thinking decision tables before implementation.
- `model-access` produces one effective policy snapshot consumed by runtime, prompt, and settings modules.
- UI rows and Agent guidance are projections of the same snapshot, not separate policy implementations.
- Saved, effective, unavailable, dormant, and scope-excluded states remain distinct schema terms.

### Background result delivery

Three commits introduced durable result persistence, removed a delivery mode, and then converged terminal delivery semantics:

- `3926adf`: changed 39 files with 2,531 insertions and 705 deletions to add persistence, acknowledgement, and bounded wake behavior.
- `9f53ead`: removed configurable next-turn delivery while retaining durable recovery.
- `19ed1dd`: isolated session fallbacks, delivered terminal errors, and aligned queue, retry, fallback, status, UI, and guidance behavior across 31 files.

Finding: delivery policy, Pi persistence, parent wake mechanics, manager lifecycle, status lookup, and UI refresh were implemented as one distributed protocol.

Required response:

- `background-result-delivery` has an explicit state machine and event-trace specification.
- Result persistence and parent messaging are separate ports.
- Branch eligibility, failed parent turns, later completions, reload, `/tree`, explicit reads, and acknowledgement each have independent examples.
- UI consumes a delivery snapshot and never drives delivery transitions.

### Failure recovery and retention

The 2026-07-29 chain retained continuable failures permanently, changed that to a 30-minute window, corrected its start condition, preserved it through concurrency blocks, and paused it while the Child screen was active. Later commits changed debug provenance and transient failure recovery.

The surviving product model is different: a failed Subagent is an ordinary `Error`, immediately enters result delivery, may be continued while its live session remains during the ordinary 10-minute retention period, is not retained merely by viewing, and is retained by pinning.

Finding: the old patch chain is valuable negative evidence, not a current requirement. Treating every historical fix as behavior to preserve would recreate superseded complexity.

Required response:

- Historical commits contribute edge-case scenarios, not automatic requirements.
- The approved lifecycle state machine explicitly records superseded states and why they are absent.
- Time starts, pauses, expiry, pinning, selection, continuation, and cleanup are table-driven and use an injected clock.
- A removed state cannot return through a local bug fix; it requires a PRD and domain-model change.

### Session shutdown and late settlement

The close path required consecutive fixes to emit child `session_shutdown`, guarantee disposal after handler failure, bound hung handlers, prevent reentrant disposal, extend the timeout, and account for late usage after records were cleared. Foreground parent interruption later added another ownership path.

Representative commits:

- `9891b24`: unified asynchronous close and guaranteed disposal.
- `1dbcdc7`: bounded shutdown and guarded reentrant disposal.
- `b1f8ad6`: extended the budget and retained late usage accounting.
- `7d895cf`: handled rejected abort promises.
- `87499bf`: bound foreground Subagent lifetime to the parent interrupt signal.

Finding: the runtime manager owned both serializable lifecycle decisions and non-serializable Pi resource teardown.

Required response:

- `subagent-runtime` owns the serializable lifecycle protocol.
- The Pi session driver owns live handles, shutdown emission, abort, timeout, disposal, and late platform events.
- Close is idempotent and has explicit setup, running, settling, closing, and closed event traces.
- Timeouts use operational configuration and injected time in application tests.

### Prompt drift

`src/prompt/agent-guidance.ts` changed eight times under the author sample, primarily because Model access and result delivery behavior were projected directly into prompt text. The exact Subagent system prompt is assembled elsewhere in the runner.

Finding: maintainers must currently inspect multiple files to understand extension-controlled prompt material, and prompt consumers can drift from runtime policy.

Required response:

- `prompt` owns Agent guidance and Subagent system prompt generation as distinct outputs.
- Prompt fragments, context sources, ordering, and deterministic assembly are documented and tested in one module.
- Model-related guidance consumes the effective `model-access` snapshot.
- The refactor adds no user-facing prompt inspection feature, session message, logging, or persistence.

### Test and documentation coupling

Hotspot test churn frequently matched or exceeded production churn. `tasks/lessons.md` records tests that invoked captured mock handlers instead of renderable component trees, and notes that module-level singletons still forced `vi.mock()`. README and `CONTEXT.md` were edited 35 and 30 times respectively under the author sample.

Finding: tests and documents often followed implementation after the fact, so current green tests alone do not prove a stable module contract.

Required response:

- Approve the PRD, domain language, migration ADRs, module boundaries, and high-risk specifications before Phase 0; derive each schema and failing acceptance example from that baseline in its vertical TDD slice.
- Test product behavior through module public seams and platform behavior through adapter contract suites.
- Ban mocks of internal modules after their replacement slice.
- Give each fact one owning document and validate links rather than copying prose.

## How history is used

For each migration slice:

1. Read the current approved requirement and module invariant.
2. Review the relevant historical cluster for missed failure scenarios.
3. Classify each historical behavior as current, superseded, or implementation-only.
4. Add current scenarios to acceptance tests before replacement.
5. Record superseded behavior in the module's decision history without implementing it.
6. Remove the old path in the same slice.

History informs the design but never overrides the approved documentation baseline.
