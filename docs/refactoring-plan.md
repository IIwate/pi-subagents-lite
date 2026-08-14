# S.U.P.E.R. refactoring plan

## Problem statement

`pi-subagents-lite` has a well-defined product model, but the implementation is accumulating change amplification. Adding a feature often crosses the mutable shell, runtime orchestration, Pi session APIs, configuration, and TUI code. Large modules then need broad internal mocks, so tests protect the current structure as much as the observable behavior.

The refactor must make later maintenance and feature development local. Except for the two explicitly approved behavior corrections below — persist-failure made explicit, and inherit of an invisible prompt source hard-fails — it must not change user-visible behavior, add a second execution path, or pause normal releases for a repository-wide rewrite.

This plan is based on local `re` branch commit `37162c8`. During migration it implemented ADR 0009, whose content now lives in [architecture decisions](architecture/decisions.md) under the retirement rule below.

The migration priorities initially used the author-scoped evidence in the refactoring history audit, a temporary anti-survivor-bias ledger recording how repeated patches exposed unstable boundaries and missed scenarios. It was never a product requirement, architecture authority, or maintenance guide. Every actionable finding was internalized into the document that owns it — the mapping is recorded in the [migration baseline](architecture/migration-baseline.md#history-finding-ownership) — and the audit file was retired in Phase 9.

The `re` branch carries the plan and will carry the complete refactoring implementation. Work remains a sequence of independently verified vertical slices on that branch; no second refactoring branch or parallel implementation tree is created. The repository owner freezes feature development on `main` for the duration, so routine synchronization from `main` is not part of the plan. An exceptional `main` change stops the active slice and requires an explicit integration decision.

## Evidence baseline

The baseline is measured from the repository, not inferred from file names:

| Signal | Baseline | Meaning |
|:--|--:|:--|
| Production TypeScript | 10,275 lines | Still small enough for incremental replacement |
| Largest source file | 1,497 lines | `AgentNavigator` contains several responsibilities |
| Four largest source files | 3,955 lines | UI, model menu, manager, and runner are concentration points |
| Longest function | 177 lines | Agent tool parsing, authorization, snapshotting, and dispatch are combined |
| Detected cycle paths | 7 | Representative paths include a direct contract cycle and shell-centered runtime cycles |
| `shell.ts` importers | 14 | The composition root acts as a service locator |
| Source `any` occurrences | 81 | Most cluster at Pi/TUI boundaries that lack local contracts |
| Test cases discovered | 849 | Behavioral coverage is substantial and should be preserved |
| Test files with module mocks | 27 | Many tests are coupled to internal module layout |
| Documentation drift | 1 visible area | README still describes Model routing and default Thinking that ADR 0008 superseded |

The highest-risk cycles are:

```text
agents/types -> types -> agents/types
agent-manager -> agent-runner -> shell -> agent-manager
shell -> spawn-coordinator -> shell
shell -> spawn-coordinator -> tool-execution -> shell
agent-manager -> agent-runner -> shell -> config-store -> agent-manager
```

Line count is not itself the defect. The defect is that these files cannot describe their responsibility in one sentence and cannot be replaced locally.

Before a behavior is migrated, each fact is read from the artifact that owns it: the approved PRD for user outcomes and scope, `CONTEXT.md` for domain language and product boundaries, the newest accepted ADR for hard-to-reverse trade-offs, module documentation for responsibility and invariants, and public-seam tests for concrete examples. README is explanatory, not normative. A conflict between authorities blocks the affected slice; the refactor does not select a winner silently. The current Model access documentation drift is therefore a Phase 0 item, not an implicit behavior change.

## Goals

1. Preserve every current public behavior in the approved PRD, `CONTEXT.md`, applicable migration decisions, and their linked acceptance examples; after ADR retirement, final decision documents become the authority.
2. Make all core policies executable with zero Pi, filesystem, TUI, timer, network, or process-global services.
3. Remove all import cycles and enforce one-way layer dependencies in tests.
4. Express every cross-module, platform, and persistence message as a validated, JSON-serializable contract without duplicating validation inside one cohesive module.
5. Confine non-serializable Pi and TUI objects to adapters.
6. Replace the mutable shell service locator with explicit composition-root wiring.
7. Split large modules by responsibility while keeping each migration slice releasable.
8. Move tests to stable behavioral seams and mock only external boundaries.
9. Centralize configuration-source precedence while keeping each capability's defaults and policy in that capability, without allowing environment sources to override interactive product policies implicitly.
10. Make component replacement cost measurable through automated architecture checks and a replacement matrix.

## Non-goals

- No user-visible feature, command, menu, schema, or behavior change beyond the approved behavior corrections.
- No rewrite in a second tree and no long-lived old/new compatibility path.
- No framework, dependency-injection container, event-bus package, or state-management package.
- No database, daemon, remote service, Docker requirement, or notification channel.
- No changes to Pi's private TUI layout contract beyond isolating it in an adapter.
- No test-count target and no blanket pursuit of 100% coverage.
- No release or package-version change as part of the refactor itself.

### Approved behavior corrections

Two silent substitutions are replaced by explicit outcomes, both of the same kind:

- Configuration persistence failure: a failed save returns an explicit user-visible failure and leaves the persisted and in-memory capability fragment unchanged instead of presenting a non-persisted mutation as current (`REQ-CONFIG-001`).
- Unavailable inherited prompt text: the run fails instead of silently continuing under the replace-mode header. An inherited persona is why the mode was chosen, and an empty, whitespace-only, or throwing host source is a malfunction the user cannot see or correct (`REQ-AGENT-001`).

No other behavior change can be classified as refactoring without separate approval.

## Documentation baseline gate

Implementation does not begin from an empty project, a second repository, or a parallel `src-v2` tree. The current implementation and its tests remain available as evidence for preserved behavior while modules are replaced in place on `re`.

Before Phase 0 implementation starts, one reviewed documentation baseline must exist:

| Artifact | Owns | Must not duplicate |
|:--|:--|:--|
| PRD | User outcomes, supported workflows, scope, and acceptance intent | Module structure and implementation details |
| `CONTEXT.md` | Project-specific ubiquitous language and product boundaries | Requirements, architecture, and implementation |
| Migration ADRs | Hard-to-reverse decisions and their trade-offs while the refactor is incomplete | Routine module documentation and permanent duplicate records |
| Module `docs/` set | Module responsibility, public boundary, invariants, decision history, and replacement conditions | PRD narratives and copied schema fields |
| History audit (migration-only) | Repeated-change evidence, hotspot analysis, and regression scenarios during planning | Requirements, domain language, and final architecture rules |

The documentation baseline is normative only after explicit review approval and a checkpoint commit on `re` containing `Review-Result: PASS`. Sources link to one another instead of repeating the same fact. Any contradiction blocks the affected migration slice until the documentation is corrected or a deliberate behavior change is approved. Current code can reveal a missing requirement, but it cannot silently override the approved baseline.

TypeBox schemas and acceptance tests are slice-level executable evidence, not prerequisites for approving prose that defines them. After the documentation gate, each TDD slice derives one boundary schema and one failing behavioral example from approved requirement IDs before adding implementation. A schema or test that contradicts the baseline is defective evidence, not an implicit requirement change.

### Documentation layout and traceability

Product requirements live under `docs/product/prd/` and are split by user workflow rather than source module. `docs/product/prd/index.md` is the sole PRD entry point and document map. Cross-module architecture documentation lives under `docs/architecture/`. ADRs remain migration-time authorities only while their content has not yet been absorbed by the final module and architecture documents.

Every requirement has a stable domain-oriented ID such as `REQ-MODEL-001`. Module `docs/` and acceptance tests reference those IDs instead of copying requirement text. CI validates that every reference resolves and that every active requirement links to at least one acceptance example and one owning capability module. The report is derived from those references; there is no separately maintained traceability matrix.

Supporting modules do not invent product requirements. In particular, `prompt` links to the requirements whose Agent guidance or Subagent system prompt it supports, but it has no user-facing requirement of its own.

The history audit is handled as input to the baseline, not as part of the final documentation set. A hotspot's boundary rationale moves to the owning module's `docs/decisions.md`; an edge case moves to `docs/testing.md` or the relevant state machine; a confirmed user outcome moves to the PRD and acceptance examples; a cross-module trade-off moves to `docs/architecture/decisions.md`. No finding is copied wholesale into multiple documents.

## User stories

1. As a maintainer, I want a feature change to touch one capability and its adapter, so that review scope stays small.
2. As a maintainer, I want import direction checked automatically, so that architectural drift fails before merge.
3. As a maintainer, I want contracts to be runtime validated and statically typed from one schema, so that boundary changes cannot drift silently.
4. As a maintainer, I want core policy tests to run without Pi or filesystem mocks, so that failures identify product logic rather than wiring.
5. As a maintainer, I want accepted Subagent behavior preserved during every migration slice, so that refactoring remains releasable.
6. As a contributor, I want one documented composition root, so that I can find where dependencies are created and connected.
7. As a contributor, I want one responsibility per file and function, so that I can understand a change without reading a thousand-line module.
8. As a contributor, I want configuration precedence in one place, so that local, CI, and hosted behavior is predictable.
9. As a contributor, I want UI state separate from Pi TUI mutation, so that I can change navigation behavior without emulating Pi internals.
10. As a contributor, I want session execution separate from scheduling, so that I can change concurrency without touching Pi session setup.
11. As a contributor, I want result-delivery rules represented as a state machine, so that branch eligibility and wake behavior remain explicit.
12. As a contributor, I want Agent type discovery separate from frontmatter parsing and merge policy, so that each can change independently.
13. As a user, I want Agent, StopAgent, and AgentStatus to keep their accepted behavior, including that inheriting an invisible prompt source fails the run instead of continuing under an empty replace-mode header, so that a host malfunction is not hidden. Persist-failure reporting is the separate accepted correction in US16 — inherit is not the only exception.
14. As a user, I want running and queued Subagents to retain their accepted run policy, so that configuration changes affect only future calls.
15. As a user, I want Child screen, background delivery, Model access, and worktree validation behavior preserved, so that no capability regresses.
16. As a user, I want a failed configuration save to report failure and retain the previous effective value, so that the UI never claims an update that was not persisted.

## Target architecture

The repository is organized by product capability. Dependencies point inward inside each module, while platform implementations remain outside the modules:

```text
index
  -> bootstrap
      -> platform/pi
      -> platform/fs
      -> platform/process
      -> modules/<module>/application
          -> modules/<module>/ports
          -> modules/<module>/core
              -> modules/<module>/contracts
```

Every module has one `public.ts` public surface and colocated documentation. Another module may import only that file, never an internal path. `public.ts` exports only boundary schemas, derived types, ports, and application entry points; module internals use direct file imports instead of additional barrel files. Architecture checks follow re-exports when detecting cycles and forbidden dependencies.

### Initial capability map

| Module | One responsibility | Internal components that are not separate modules |
|:--|:--|:--|
| `agent-catalogue` | Discover, merge, and expose Agent type definitions | Frontmatter parsing, source precedence, tool/skill/extension policy resolution |
| `model-access` | Decide Parent model, alternate model, Provider, scope, and Thinking authorization | Access normalization, effective policy projection |
| `subagent-runtime` | Accept runs and own the ephemeral Subagent lifecycle | Scheduling, worktree targeting, interaction, retention, debug faults |
| `background-result-delivery` | Decide durable result eligibility, presentation, acknowledgement, and restoration | Active-branch projection, failed-delivery recovery |
| `child-screen` | Own renderer-independent Child screen navigation and presentation state | Selection, folding, transcript/list/footer projection, interaction notices |
| `settings` | Compose renderer-independent settings workflows | Menu flow, settings view models, delegation to policy-owning modules |

`prompt` is a supporting module, not a product capability. It centralizes Agent guidance, Subagent system prompt construction, prompt fragments, and context assembly rules for source, test, and documentation review. It does not add a menu, command, runtime viewer, persisted prompt record, or advertised feature.

`configuration` is a supporting module, not a product capability. It owns access to the current configuration document, source precedence, in-memory document revisions, and atomic fragment transactions. It does not own product defaults, normalization, update policy, UI effects, or runtime side effects; those remain in the capability that defines each setting.

Worktree targeting and scheduling begin as cohesive internal components of `subagent-runtime`. They become top-level modules only after an independent consumer or replacement need is demonstrated. Extension-controlled prompt material and its assembly remain owned exclusively by `prompt`.

`prompt/public.ts` accepts explicit serializable assembly requests and returns prompt strings. `subagent-runtime` calls it with a `SubagentPromptRequest` derived from the accepted run policy. The Parent `before_agent_start` integration calls a `prompt` application use case whose catalogue and model-access reader ports are connected by `bootstrap` to those modules' public facades. `prompt` never imports their implementations or reads Pi context, configuration storage, or another module's internal files. No other module owns or retains extension-controlled prompt fragments.

The planned technical responsibilities inside and around modules are:

| Area | Single responsibility | Must not know about |
|:--|:--|:--|
| Module `docs/` | Define one module's responsibility, public boundary, decision history, and replacement conditions | Duplicated PRD or ADR content |
| Module `contracts` | Define schemas and derived types for that module's public boundary | Pi, filesystem, TUI, timers, implementations |
| Module `core` | Hold that module's pure decisions and projections | Platform services and other modules' internals |
| Module `application` | Execute one use case by composing its core and ports | Concrete platform implementations |
| Module `ports` | Define required host operations using serializable request/response data | Concrete Pi and Node types |
| `configuration` | Resolve external configuration sources and transact opaque validated capability fragments | Product defaults, policy, UI effects, runtime synchronization |
| `prompt` | Deterministically assemble extension-controlled prompt text | Pi callbacks, configuration persistence, menus, advertised capabilities |
| `platform/pi` | Translate Pi tools, events, sessions, messages, and TUI | Product policy |
| `platform/fs` | Read/write config and read Agent definitions, context files, and worktree metadata | Runtime orchestration and UI |
| `platform/process` | Provide clock, IDs, environment, timers, and reload-surviving state | Product policy |
| `bootstrap` | Construct platform implementations and connect them to module-owned ports | Product branching logic |

`platform/pi/tui` is the only owner of Pi components, keyboard translation, private-layout detection, component ownership checks, and rendering. `child-screen` and `settings` expose only serializable commands and view snapshots, so repeated UI changes do not reopen product policy or runtime modules.

### Contract families

Contracts use TypeBox schemas with `Static<typeof Schema>` types. The first families are:

- `AgentCommand`, `AgentEvent`, `AgentSnapshot`, and `AgentResult`;
- `SpawnRequest`, `AcceptedRunPolicySnapshot`, and `SessionEvent`;
- `ModelSnapshot`, `ModelScopeSnapshot`, and `ModelAuthorizationResult`;
- `DeliveryCommand`, `DeliveryEvent`, and `DeliverySnapshot`;
- `ConfigurationDocumentSnapshot`, `ConfigurationFragmentTransaction`, and `ConfigurationCommitResult`;
- `NavigatorCommand`, `NavigatorSnapshot`, and `RenderedLine`;
- `SettingsCommand`, `SettingsSnapshot`, and `SettingsActionResult`;
- `AgentDefinitionSnapshot` and `AgentCatalogueSnapshot`.

Every value crossing an architectural module, platform, or persistence boundary is schema-validated at the receiving boundary and JSON round-trippable. Functions, classes, maps, sets, errors, abort signals, and platform handles cannot appear in these contracts. Files inside one cohesive module use ordinary TypeScript types where no replaceable boundary is crossed.

Each configuration-owning capability also defines its own fragment schema. `configuration` treats a fragment as serialized data after the owning capability validates it; it never interprets a model-access, runtime, display, or prompt setting.

The refactor preserves the existing unversioned `subagents-lite.json` physical shape, including its `modelRouting`, `agent`, and `concurrency` sections. `ConfigurationDocumentSnapshot.revision` is transaction metadata held in memory and is not written as a schema-version field. A physical configuration-format change requires a separate approved product change; this refactor adds no dual-format reader or migration layer.

### Port boundaries

Ports are narrow and operation-specific:

- `SessionDriver`: create, prompt, steer, abort, close, and report serializable session events by session ID.
- `ResultRepository`: read, append, and acknowledge durable result records.
- `ConfigurationDocumentRepository`: load a document snapshot and atomically replace one validated capability fragment without exposing filesystem details.
- `AgentCatalogueRepository`: load serialized Agent definitions from configured roots.
- `WorktreeInspector`: validate repository identity and return a resolved path snapshot.
- `ParentMessenger`: deliver one serialized background result message.
- `RuntimeClock`, `IdGenerator`, and `RuntimeScheduler`: isolate time, IDs, and timers.
- `NavigatorRenderer`: apply a `NavigatorSnapshot` without exposing TUI components inward.
- `EnvironmentSource`: resolve paths and process settings using the required precedence.

An adapter can keep a private map from session ID to Pi `AgentSession`. That handle never enters application state.

### Replacement matrix

| Replace | Files allowed to change | Core/application change |
|:--|:--|:--|
| Pi host | `platform/pi/**`, `bootstrap/**` | None |
| Pi TUI | `platform/pi/tui/**`, bootstrap wiring | None |
| JSON config file | one `ConfigurationDocumentRepository` platform implementation | None |
| Pi child-session engine | one `SessionDriver` adapter | None |
| Result persistence | one `ResultRepository` adapter | None |
| Scheduler policy | `core/scheduling/**` and its tests | No other feature area |
| Agent definition source | one catalogue repository adapter | None |

If a replacement requires edits outside its row, the boundary has failed and the slice is not complete.

### Module documentation contract

Every `src/modules/<module>/docs/` directory starts with these documents. Modules do not use a colocated README as a second documentation entry point:

- `index.md`: responsibility, explicit non-responsibilities, linked PRD requirements, domain terms, and document map.
- `contracts.md`: public commands, events, snapshots, and ports by schema symbol.
- `testing.md`: approved behavioral seams, adapter contracts, fixtures, and required verification.
- `decisions.md`: Current, Superseded, and Implementation-only historical decisions with links to relevant commits and migration ADRs or their final architecture-document replacements.

Modules add focused documents when the subject exists rather than forcing empty sections:

- `state-machine.md` for lifecycle or delivery transitions;
- `decision-tables.md` for authorization and policy combinations;
- `ui-states.md` for renderer-independent interaction matrices;
- `prompt-sources.md` for prompt ownership, ordering, context sources, and deterministic assembly;
- `operations.md` for operational configuration and failure boundaries;
- `replacement.md` for dependencies, replacement steps, and expected change scope.

Module documentation never copies schema field lists or PRD narratives. During migration it links to ADR rationale instead of duplicating it; during Phase 9 it consolidates that rationale under the retirement contract below and replaces the ADR as the single authority. CI requires `docs/index.md`, `docs/contracts.md`, `docs/testing.md`, and `docs/decisions.md` for every module, requires the applicable focused documents for high-risk modules, and validates all repository-local links.

### ADR retirement contract

The target architecture does not retain a separate ADR system. During migration, accepted ADRs remain authoritative so their rationale is not lost before the replacement documents exist. Phase 9 retires an ADR only after:

1. module-specific context, trade-offs, rejected alternatives, and supersession history are consolidated into the owning module's `docs/decisions.md`;
2. cross-module decisions are consolidated into `docs/architecture/decisions.md`;
3. requirements, module documents, tests, and source references point to the replacement documents;
4. repository-local link and traceability checks pass with the ADR removed.

`CONTEXT.md` remains a glossary and never absorbs implementation rationale. ADR content is consolidated rather than copied, so retirement leaves one final authority for each decision.

## Testing decisions

### Approved seams for the plan

Implementation must not start until the maintainer confirms these seams:

1. Primary seam: the application facade accepts a schema-valid command and returns a schema-valid result plus events.
2. Host seam: the registered Agent, StopAgent, and AgentStatus callbacks are exercised through a Pi adapter harness.
3. UI seam: navigation commands produce a renderer-independent `NavigatorSnapshot`; a small Pi TUI contract suite verifies snapshot application.
4. Persistence seam: repository adapters share contract tests for load, save, append, acknowledge, malformed input, and atomic failure.
The primary seam covers most behavior. The other seams exist only where the host or persistence contract itself is the behavior.

### TDD loop for every slice

1. Select one approved requirement example and its highest pre-agreed public seam.
2. Define or extend one TypeBox contract for that behavior.
3. Add one failing behavioral test with independent literal expectations.
4. Verify the failure is caused by missing behavior, not test setup.
5. Implement only enough of one vertical path to pass.
6. Cut the public call site to that path and delete the replaced path in the same slice.
7. Run the focused test, typecheck, and full suite.
8. Review against S.U.P.E.R. Any structural refactor is a review fix after the red-green loop and requires the checks to run again.

Tests assert observable results, snapshots, and emitted events. They do not call private methods, inspect internal maps, mock internal modules, or assert collaborator call order. Expected values come from documented examples and fixed literals, not a reimplementation of the algorithm.

External boundary mocks are allowed for Pi, filesystem failure, time, IDs, and process environment. In-memory implementations of application ports are preferred over module mocks.

### Architecture tests

Add a focused test suite using the existing TypeScript compiler API. It must assert:

- zero import cycles, including type-only imports;
- capability modules import other modules only through explicit public surfaces;
- the allowed inward dependency matrix inside every module;
- no Pi, Pi TUI, Node filesystem, process-global, or timer imports inside module `contracts`, `core`, or `application`;
- every contract schema has representative validation and JSON round-trip tests;
- source files above 400 lines and functions above 60 lines produce review warnings; dependency direction and responsibility, not size alone, determine failure;
- no `shell.ts` import or new service-locator module exists after the composition-root cutover.

### Required pre-implementation specifications

- `model-access/docs/decision-tables.md` covers Parent model, alternate model, Provider, availability, scope, saved-rule, and Thinking combinations.
- `subagent-runtime/docs/state-machine.md` covers acceptance, queueing, setup, running, settlement, continuation, stop, expiry, and close event traces with explicit time semantics.
- `background-result-delivery/docs/state-machine.md` covers persistence, eligibility, presentation, failure, later completion, acknowledgement, reload, `/tree`, and explicit reads.
- `child-screen/docs/ui-states.md` and `settings/docs/ui-states.md` define renderer-independent state matrices across Main/Child, expanded/folded, lifecycle and failure states, viewport widths, and regular/fullscreen modes. Core contracts do not freeze colors or incidental spacing.
- `prompt/docs/prompt-sources.md` identifies every extension-controlled prompt fragment, its inputs, ordering, determinism rules, and owning test. It defines no user-facing inspection feature.
- `configuration/docs/operations.md` identifies source precedence, transaction boundaries, persistence-failure behavior, and the ownership of every configuration fragment.

## Migration plan

Each phase is one or more vertical-slice commits. Every slice runs its focused test, typecheck, full suite, and S.U.P.E.R. self-check before commit, but the formal code review runs once at the end of the phase over every commit since the previous review checkpoint. Review fixes are completed and all required checks rerun before the phase checkpoint records `Review-Result: PASS`.

### Phase 0: Freeze behavior and install guardrails

Purpose: make architecture regression visible before moving behavior.

- Record the baseline tool, lifecycle, delivery, model-access, worktree, configuration, and Child screen behaviors already covered by tests.
- Walk every finding in the history audit, classify it as Current, Superseded, or Implementation-only, and transfer its actionable consequence to exactly one owning PRD, module document, architecture decision, or acceptance example.
- Restore the Windows test baseline: the two directory-link cases currently fail during `symlinkSync` setup with `EPERM` when Developer Mode or link privilege is unavailable. Make the test fixture capability-aware while preserving real-path validation behavior. Supported environments run all 849 cases; unsupported environments skip only those two setup-blocked cases with an explicit capability condition.
- Add blocking dependency checks with an exact baseline for existing cycle paths and internal module mocks. New violations fail immediately; every migration slice removes its resolved baseline entries in the same commit. Size checks report growth beyond the current baseline for explicit responsibility review.
- Resolve the README wording that conflicts with ADR 0008 and current Model access behavior before using README as characterization input.
- Add the layer map and S.U.P.E.R. checklist to the pull-request template or review instructions.
- Confirm the four test seams above before writing new behavioral tests.

Exit:

- Typecheck passes and the full test command exits successfully on supported Windows and CI environments. Environments with directory-symlink capability run all 849 cases; environments without it report only the two capability-conditioned skips.
- No new cycle, oversize module, internal module mock, or boundary `any` can be added unnoticed.
- Existing tests are not bulk rewritten.

### Phase 1: Establish composition through one Agent catalogue tracer slice

Purpose: prove the target shape through one complete behavior instead of creating dormant folders and facades.

- Create `public.ts`, contracts, core, application, ports, platform implementation, and module `docs/` only as the first Agent catalogue behavior needs them.
- Introduce the smallest `bootstrap` factory required to construct that path and inject its platform dependencies.
- Introduce `configuration` through the catalogue-owned fragment used by that path. Preserve the current physical JSON shape and keep the in-memory revision outside the file.
- Define the Agent definition and accepted-call boundary with TypeBox, removing the direct `agents/types -> types -> agents/types` cycle and the replaced handwritten shapes.
- Cut one real registration or discovery call site to the new facade and delete its old implementation in the same slice.

Exit:

- One production behavior runs only through the new public surface, with no dormant parallel path.
- The direct type cycle is gone.
- The current JSON configuration remains byte-shape compatible after a load/save round trip.
- The tracer slice passes its public-seam test, typecheck, full suite, and S.U.P.E.R. review.

### Phase 2: Complete Agent catalogue and Model access

Purpose: stabilize Agent definitions and authorization before runtime and prompt assembly depend on them.

- Move Agent discovery, frontmatter parsing, source precedence, merge rules, and tool/skill/extension policy resolution into `agent-catalogue`.
- Move Parent model access, Provider and exact-model authorization, Pi availability, Model scope, dormant rules, and Thinking access into `model-access`.
- Migrate the catalogue and model-access configuration fragments while retaining their existing physical JSON fields.
- Drive every combination from the approved Model access decision table and independent literal expectations.
- Keep existing Pi menus as translation-only platform code until `settings` is migrated; they call capability commands and contain no policy.
- Move Agent tool authorization and accepted policy projection behind the modules' public schemas.

Exit:

- Agent discovery and Model access run without Pi, filesystem, menu, or runtime mocks.
- The Agent tool platform implementation only validates input, invokes public application use cases, and formats output.
- No catalogue or Model access policy remains in configuration, menus, `AgentManager`, or tool execution.

### Phase 3: Centralize prompt assembly

Purpose: make all extension-controlled prompt material inspectable and deterministic without creating a user-facing prompt capability.

- Move Agent guidance, Subagent system prompt templates, fragments, source ordering, and context assembly into `prompt`.
- Define `AgentGuidanceRequest` and `SubagentPromptRequest` schemas and golden behavioral examples from `prompt/docs/prompt-sources.md`.
- Connect the Parent guidance application use case to Agent catalogue and Model access reader ports through `bootstrap`.
- Cut the existing `before_agent_start` handler and current runner to `prompt/public.ts`, then delete prompt assembly from `events.ts`, `agent-runner`, and other owners.
- Keep custom prompt and context-file I/O in `platform/fs`; only their serialized contents cross into `prompt`.

Exit:

- Every extension-controlled prompt fragment and ordering rule has one source owner and one documented test.
- Prompt tests require no Pi, filesystem, configuration store, or runtime service.
- No prompt menu, command, viewer, log, persisted snapshot, or advertised capability exists.

### Phase 4: Replace Subagent runtime

Purpose: replace `AgentManager` and `agent-runner` after their catalogue, authorization, and prompt dependencies are stable.

- Extract pure hierarchical concurrency scheduling through one spawn/settle tracer slice.
- Represent lifecycle changes as serializable commands and events reduced into `AgentSnapshot` state.
- Give separate application use cases to spawn, stop, interact, inspect, pin, expire, and close.
- Keep worktree targeting cohesive inside `subagent-runtime` and move filesystem validation to `WorktreeInspector`.
- Move Pi session creation, resource loading, provider execution, transient retry integration, and live session handles into the Pi `SessionDriver` platform implementation.
- Move clock, ID generation, retention, teardown timeout, and cleanup scheduling behind configured ports.
- Delete each migrated manager/runner responsibility and its shell accessor immediately; remove both old modules after the final runtime slice.

Exit:

- Scheduling and lifecycle tests require no Pi or fake session object.
- The application stores only serializable Subagent state and stable session IDs.
- Session-driver contract tests cover setup, progress, completion, error, abort, continuation, and close.
- `AgentManager` and `agent-runner` no longer exist.

### Phase 5: Replace Background result delivery

Purpose: separate delivery policy from Pi persistence and parent wake mechanics after runtime emits stable terminal events.

- Model pending, eligible, presented, acknowledged, failed, and restored transitions in `background-result-delivery`.
- Keep parent-session entry reads and writes in `ResultRepository`.
- Keep active-branch discovery and parent wake/follow-up delivery in Pi platform implementations.
- Drive delivery with parent lifecycle commands and serializable runtime events.
- Preserve the branch eligibility, failed-turn, later-completion, reload, `/tree`, and explicit AgentStatus acknowledgement semantics in `CONTEXT.md`.
- Remove `SpawnCoordinator` and its shell accessor after its final spawn and delivery responsibilities move.

Exit:

- Delivery policy tests use only commands, snapshots, and expected events.
- Persistence failure is tested through repository contracts, not module mocks.
- Replacing result storage or parent messaging changes one platform implementation each.
- `SpawnCoordinator` no longer exists.

### Phase 6: Replace Child screen state and Pi rendering

Purpose: remove the largest change hotspot without coupling renderer-independent state to Pi 0.84 layout details.

- Extract pure navigation state for selection, folding, pin and clear confirmation, interaction notices, and terminal transitions.
- Extract transcript, list, footer, and status projection into renderer-independent snapshots.
- Keep timers, editor interception, keyboard translation, component ownership checks, ScrollView behavior, and layout mutation in small `platform/pi/tui` implementations.
- Preserve the fail-closed private-layout behavior from ADR 0007 in platform contract tests.
- Delete each replaced `AgentNavigator` responsibility; remove the old module after the final Child screen slice.

Exit:

- Child screen decisions run without Pi TUI.
- Pi private-layout code is confined to `platform/pi/tui`.
- Renderer contracts cover regular/fullscreen switching, shrink clearing, footer replacement, ownership conflict, and restoration.
- `AgentNavigator` no longer exists.

### Phase 7: Replace Settings and finish configuration ownership

Purpose: compose settings only after every policy-owning capability exposes a stable command surface.

- Implement renderer-independent settings workflows and view snapshots in `settings`; it delegates every update to the owning module.
- Migrate remaining runtime, prompt, display, and operational configuration fragments with their owning capabilities while retaining the current physical JSON fields.
- Apply environment > `.env` > config file > capability-owned defaults only to operational settings.
- Persist a proposed fragment before publishing it as current in-memory state. A failed save returns an explicit failure and changes no consumer.
- Let consumers pull immutable snapshots through explicit application calls; add no global configuration-change event bus.
- Keep menu rendering, selection, and Pi input translation in `platform/pi/tui`.
- Remove `ConfigStore`, direct manager/navigator synchronization, and the monolithic menu modules after their final settings paths migrate.

Exit:

- Settings state and configuration policy tests use plain JSON values without Pi TUI.
- File, environment, and `.env` precedence has platform contract coverage.
- No environment source overrides an interactive product policy implicitly.
- Changing the configuration repository or settings renderer changes one platform implementation each.
- `ConfigStore` and the monolithic menu modules no longer exist.

### Phase 8: Complete the composition-root cutover

Purpose: remove the remaining service locator only after every state owner has moved to an explicit module.

- Make registration and lifecycle callbacks close over the one runtime constructed by `bootstrap`.
- Isolate the session-keyed fallback result inbox and child-spawn async marker behind the process-state port.
- Delete each remaining shell getter and setter with its final caller; do not retain a renamed shell or generic service container.
- Remove `shell.ts` and mark ADR 0004 superseded by ADR 0009 at the cutover checkpoint.
- Prove that two runtimes can be constructed in one test without sharing ordinary session state.

Exit:

- `shell.ts` is absent and all shell-centered cycle baselines are zero.
- Runtime startup and shutdown pass through the host seam.
- Only the two explicitly approved reload-surviving process-state responsibilities use process-global storage.

### Phase 9: Consolidate tests and enforce the final architecture

Purpose: remove obsolete scaffolding and convert all remaining target rules into blocking checks.

- Replace remaining internal `vi.mock` usage with application-seam tests or platform contract tests.
- Remove obsolete fixtures, duplicate types, unused exports, and superseded architecture comments.
- Consolidate every migration ADR into the owning module `docs/decisions.md` or `docs/architecture/decisions.md`, update all references, and retire the fully absorbed ADR files.
- Verify that every history-audit finding has one final owner, update all references, and retire `docs/refactoring-history-audit.md`; it must not remain a second maintenance backlog.
- Enable zero-cycle, public-surface, full dependency-direction, document-link, and requirement-traceability enforcement.
- Update README and final decision documents only where the completed implementation changes architectural facts.
- Run the replacement matrix as a review exercise and record any exception as a blocking defect.

Exit:

- Zero import cycles and zero inward-to-outward dependency violations.
- Zero internal module mocks; test doubles remain only at external ports.
- Every boundary value is schema-defined, validated, and JSON-serializable.
- Every active requirement resolves to module documentation and an acceptance example.
- No standalone ADR remains after its rationale and supersession history have one verified final owner.
- `bun run typecheck` and `bun run test` pass.
- All ten S.U.P.E.R. review checks pass.

## Change ordering and review cadence

Do not implement one phase as one large commit. Prefer one vertical behavior per commit, normally changing one contract, one use case, one platform path, and its tests. A slice should remove at least as much obsolete ownership as it adds; file count can rise, but duplicate behavior cannot.

Recommended order inside a phase:

1. One contract and one failing behavioral example.
2. One pure decision or use case.
3. One adapter translation.
4. Cut the public call site to the new path.
5. Remove the replaced code and tests coupled to it.
6. Review, typecheck, full test, S.U.P.E.R. gate.

Avoid commits that only move files without changing boundaries. A move is useful only when the same slice removes a dependency violation or isolates one responsibility.

Slice commits remain independently green but do not trigger a separate formal code-review pass. At phase end, review the inclusive diff since the previous `Review-Result: PASS` checkpoint, fix every finding, rerun typecheck and the full suite, and create one checkpoint commit containing that line. The next review begins after that checkpoint.

## Risk controls

| Risk | Control |
|:--|:--|
| Behavior drifts during extraction | Test through the public application/host seam before replacing each path |
| A temporary abstraction becomes permanent | Delete the old path in the same vertical slice; no compatibility layer |
| Pi private APIs leak back inward | Architecture test bans Pi imports outside `platform` and `bootstrap` |
| Serializable contracts become type-only promises | Validate at adapter entry and require JSON round-trip tests |
| More files create navigation overhead | One responsibility per directory, local index only when it defines a public module surface |
| Tests become slow integration tests | Pure application tests use in-memory ports; only adapter contracts load Pi/TUI |
| Configuration precedence surprises users | One resolver with table-driven precedence tests and capability-owned documented defaults |
| Refactor blocks feature work | Keep slices releasable and merge feature work through the same target boundary |

## Per-task S.U.P.E.R. review gate

Every implementation task must record all ten results before completion:

| # | Check | Required evidence |
|:--|:--|:--|
| 1 | Every new module/file has one responsibility | One-sentence responsibility in review |
| 2 | No function does more than one conceptual thing | Responsibility review, with size warnings as prompts |
| 3 | Data flows input -> processing -> output | Command/result/event trace |
| 4 | No circular imports | Dependency test |
| 5 | Cross-module interfaces are schema-defined | TypeBox schema reference |
| 6 | Module I/O is serializable | Validation and JSON round-trip test |
| 7 | No hardcoded path, URL, key, or config | Configuration/defaults review |
| 8 | Dependencies are declared | `package.json` and lockfile review |
| 9 | Modules are replaceable locally | Replacement-matrix row |
| 10 | All tests pass | Typecheck and full test output |

Any failure blocks completion. One or two failures are fixed in the same task. Three or more failures stop the slice and require redesign before more implementation.

## Completion criteria

The refactor is complete only when all of these are true:

- Public behavior remains consistent with the approved PRD, `CONTEXT.md`, final decision documents, and linked acceptance examples.
- The source dependency graph is acyclic and follows the declared layer matrix.
- Core and application tests run with zero external services.
- Pi, Pi TUI, filesystem, environment, timers, IDs, and process globals are adapter-owned.
- Every cross-layer value is schema-defined and serializable.
- The mutable shell, `AgentManager`, `SpawnCoordinator`, `ConfigStore`, monolithic `AgentNavigator`, and monolithic menu modules have been removed rather than wrapped.
- Operational configuration follows environment > `.env` > config file > capability-owned defaults; interactive product policies are not overridden implicitly.
- The replacement matrix passes without cascading changes.
- Migration ADRs have been consolidated into module or system architecture decision documents and retired without broken references.
- The temporary history audit has been fully internalized and retired without losing a regression scenario or decision rationale.
- Typecheck, the full suite, architecture tests, and the ten-item S.U.P.E.R. review all pass.

Until those conditions are met, work is reported as an incomplete migration, not as a completed refactor.
