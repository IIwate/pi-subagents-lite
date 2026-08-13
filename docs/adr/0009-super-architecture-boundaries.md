---
status: proposed
implementation: planned
---

# S.U.P.E.R. boundaries and serializable application contracts

## Context

The extension has clear product concepts, but its implementation boundaries no longer match them. At commit `37162c8`, the source tree has 10,275 lines and the four largest implementation files contain 3,955 of them. The dependency audit detected seven representative cycle paths. `shell.ts` has fourteen importers and participates in cycles that connect agent execution, result delivery, configuration, and the TUI.

Several classes also own unrelated state transitions and platform details:

- `AgentManager` owns records, scheduling, Pi session handles, continuation, cleanup, pinning, and debug faults.
- `SpawnCoordinator` owns spawning, durable delivery, branch eligibility, wake scheduling, and UI refreshes.
- `AgentNavigator` owns input routing, navigation state, transcript projection, Pi private-layout mutation, timers, and rendering.
- `ConfigStore` owns normalization results, mutation commands, persistence, and direct manager/navigator synchronization.

This makes replacement expensive. A change to one host concern can require edits in policy, runtime, UI, and tests. It also conflicts with the mandatory S.U.P.E.R. standard.

## Decision

The codebase will be a capability-oriented modular monolith. A module is one product capability that can be described, tested, and replaced independently. Technical layers live inside that capability instead of becoming repository-wide folders that scatter one feature across the tree.

Each capability module may contain these inward dependency layers when the capability needs them:

1. `application`: executes one use case through ports.
2. `core`: contains pure policy, reducers, scheduling, normalization, and projections.
3. `contracts`: contains TypeBox schemas and derived TypeScript types for the module's public boundary.

Platform implementations live outside capability modules under `platform`, and `bootstrap` is the only place that constructs them and connects them to module-owned ports. A module exposes exactly one `public.ts` surface containing boundary schemas, derived types, ports, and application entry points. Other modules cannot import its internal files, and internal layers use direct imports rather than additional barrel files. Architecture checks follow re-exports when detecting cycles and forbidden dependencies.

`contracts` and `core` must not import Pi packages, Pi TUI, Node filesystem APIs, process globals, timers, or platform implementations. `application` may import its own ports, `core`, and `contracts`, plus another module's explicit public contract when collaboration is required. Platform implementations may import module ports and platform APIs. Only `bootstrap` may construct implementations and connect them.

Every module owns a colocated `docs/` document set that states its responsibility and public boundary. The documentation links to product requirements and ADRs instead of duplicating them.

The initial capability modules are:

- `agent-catalogue`: discovers, merges, and exposes Agent type definitions.
- `model-access`: owns Parent model, alternate model, Provider, scope, and Thinking authorization decisions.
- `subagent-runtime`: accepts runs and owns Subagent lifecycle, scheduling, interaction, retention, and session commands.
- `background-result-delivery`: owns durable result eligibility, presentation, acknowledgement, and restoration decisions.
- `child-screen`: owns renderer-independent Child screen navigation and presentation state.
- `settings`: composes renderer-independent settings workflows while delegating policy changes to the module that owns each policy.

`prompt` is a supporting module rather than a user-facing capability. It centralizes Agent guidance, Subagent system prompt construction, prompt fragments, and context assembly rules so maintainers can inspect and change extension-controlled prompt material in one place. It adds no menu, command, runtime viewer, persistence, or advertised product capability.

`configuration` is a supporting module rather than a product capability. It owns access to the current configuration document, source precedence, in-memory document revisions, and atomic fragment transactions. Each capability owns the schema, defaults, normalization, and update policy for its own fragment. `configuration` does not interpret product settings or synchronize runtime and UI objects.

`prompt/public.ts` accepts serializable assembly requests and returns prompt strings. `subagent-runtime` calls it to assemble the Subagent system prompt from an accepted run policy. The Parent `before_agent_start` integration calls a `prompt` application use case whose catalogue and model-access reader ports are connected to those modules' public facades by `bootstrap`. `prompt` does not import their implementations or read Pi context, configuration storage, or internal module files. No other module owns extension-controlled prompt fragments.

`platform/pi/tui` translates `child-screen` and `settings` commands and snapshots to Pi components, keyboard input, layout ownership checks, and rendering. Product modules never construct or retain Pi TUI components.

Every module contains a `docs/` directory and does not use a colocated README as a second documentation entry point. Its `index.md` records responsibility, non-responsibilities, related PRD requirements, and document ownership. Additional documents separately cover public contracts, state and invariants, allowed dependencies, main flows, failure boundaries, owned configuration, approved test seams, replacement procedure, and decision history where relevant. Exact fields remain in linked TypeBox schemas instead of being copied into prose. CI validates the required document set and repository-local links.

### Serializable boundaries

Every request, response, event, snapshot, and persisted value that crosses an architectural module, platform, or persistence boundary must be JSON-serializable and have a TypeBox schema. TypeScript types must be derived from those schemas rather than maintained as parallel handwritten shapes. Calls between files inside one cohesive module may use ordinary TypeScript types and do not repeat runtime validation.

Pi objects such as `ExtensionContext`, `AgentSession`, TUI components, `AbortSignal`, timers, and filesystem handles must remain inside their adapter. An adapter exposes stable string IDs and serializable snapshots across its port. Cancellation is translated to a serializable application command. Session progress is translated to serializable events.

Port implementations are wired as ordinary objects, but all data passed through their methods follows a schema-defined contract.

### Application boundary

The primary behavioral seam is an application facade that accepts a discriminated command and returns a result plus emitted domain events. The facade delegates each command to a single-purpose use-case module; it does not contain policy branches itself.

The initial command families are:

- spawn, stop, inspect, and interact with a Subagent;
- accept Pi session events and parent lifecycle events;
- read and update each capability's owned settings;
- discover Agent types;
- read and update navigator state.

The application owns serializable state. Concrete session handles and TUI components remain in adapters and are referenced by stable IDs only.

### Runtime ownership

The mutable service locator in `shell.ts` was removed at the Phase 8 cutover. `bootstrap/extension-runtime.ts` creates one runtime record for one Pi extension instance, and registration plus lifecycle callbacks close over explicit application and adapter dependencies.

Process state that must survive Jiti reload remains isolated in `platform/process/process-state.ts`. Its only accepted responsibilities are the session-keyed fallback result inbox and the async child-spawn marker already justified by ADR 0004. No ordinary runtime service may be stored on `globalThis`.

This ADR supersedes ADR 0004's module-level shell decision; ADR 0004 is retained as history of the pre-cutover implementation.

### Configuration

Operational configuration is resolved through the `configuration` support module with this precedence:

1. environment variables;
2. `.env` values;
3. the persisted configuration file;
4. defaults owned by the capability that consumes the setting.

This precedence applies to startup paths, timeouts, retention periods, concurrency defaults, and similar runtime settings. Interactive product policies such as Model access and Thinking access remain owned by persisted capability fragments unless a separate decision explicitly defines an environment override and its user-interface semantics. Platform path construction belongs to the filesystem/environment implementation.

The owning capability validates and computes a proposed fragment, then requests an atomic configuration transaction. Only a successful commit becomes the module's current in-memory snapshot. Failure leaves all consumers unchanged and returns an explicit error. Consumers pull immutable snapshots through module application calls; there is no global configuration-change event bus and no configuration service that calls runtime or UI objects.

The persisted `subagents-lite.json` remains in its current unversioned physical shape with `modelRouting`, `agent`, and `concurrency` sections. An in-memory document revision orders transactions but is never written as a schema-version field. Changing the physical format requires a separate approved product change; this refactor creates neither a dual-format reader nor a migration layer.

Persisted configuration and durable results are external state. In-memory runtime state is ephemeral, session-scoped, and reconstructible from accepted commands, platform events, and persisted snapshots where the product contract requires restoration.

### Migration rule

The refactor remains in this repository on the `re` branch. It does not start from an empty project and does not create a parallel `src-v2` tree. Existing tests and implementation provide behavior evidence while approved documentation defines the intended baseline.

Implementation starts only after a documentation baseline is reviewed and approved. Product PRDs under `docs/product/prd/` own user outcomes and scope, `CONTEXT.md` owns project-specific language, ADRs own hard-to-reverse trade-offs, and module documentation owns responsibility and public boundaries. The approved baseline is recorded by a checkpoint commit on `re` containing `Review-Result: PASS`.

After that gate, each vertical TDD slice derives one TypeBox boundary schema and one failing acceptance example from approved requirement IDs before it adds implementation. Schemas own executable data shapes and tests own concrete behavioral examples, but neither can silently redefine the documentation baseline. All sources link to one another rather than duplicate the same statement. Stable requirement IDs connect PRDs, module documentation, schemas, and acceptance tests, and CI validates those references instead of relying on a separately maintained traceability matrix. A conflict blocks the affected slice until the baseline is corrected or an explicit new decision is approved.

Migration then proceeds as behavior-preserving vertical slices. Each slice defines one contract, adds one failing public-seam test, implements the new path, and removes the replaced path in the same slice. The repository will not keep parallel old/new execution paths, compatibility layers, temporary facades, or fallback behavior without a separately approved product requirement.

Existing public behavior remains unchanged unless the approved PRD explicitly changes it. This includes the Agent, StopAgent, and AgentStatus tool contracts; accepted run policy; worktree validation; background result delivery; Model access; concurrency; and Child screen behavior. The sole correction approved as part of this refactor is configuration persistence failure: a failed save returns an explicit failure and leaves the effective in-memory fragment unchanged instead of logging and presenting a non-persisted mutation as current.

## Enforcement

Automated architecture tests will fail on:

- any import cycle, including type-only cycles;
- an inward layer importing an outward layer;
- platform packages or Node side-effect APIs imported by `contracts`, `core`, or `application`;
- a boundary contract without schema validation and JSON round-trip coverage;
- unreviewed growth beyond the 400-line file or 60-line function warning thresholds.

Size thresholds are review signals, not architectural proof. An item above a threshold is acceptable when its responsibility remains singular and the review records why splitting it would reduce cohesion. Import cycles and dependency-direction violations remain absolute failures.

Review also applies the ten-item S.U.P.E.R. checklist from the project instructions. Passing TypeScript and tests is necessary but not sufficient.

Every vertical-slice commit runs its focused test, typecheck, full suite, and S.U.P.E.R. self-check. Formal code review is batched once per migration phase across all commits since the previous checkpoint. Review fixes and required checks must pass before the phase checkpoint commit records `Review-Result: PASS`; the next review begins after that commit.

## Replaceability checks

The target architecture is acceptable only when these changes have the stated scope:

- Replacing Pi with another host changes only the host adapter and bootstrap wiring.
- Replacing Pi TUI with another renderer changes only the UI adapter.
- Replacing JSON-file configuration changes only the configuration document repository platform implementation.
- Replacing Pi child sessions changes only the session-driver adapter.
- Replacing the scheduler changes only the scheduler module and its contract tests.
- Replacing result persistence changes only the result repository adapter.

## Consequences

The refactor adds explicit contracts and small orchestration modules, so there will be more files. Each file has one named responsibility and the dependency graph becomes mechanically enforceable.

Platform adaptation becomes more deliberate because Pi objects cannot leak into application state. In return, core behavior can run with in-memory ports and zero external services, tests stop depending on internal module mocks, and feature work can extend one vertical capability without reopening unrelated runtime and UI modules.

No new runtime dependency is required. TypeBox and TypeScript already provide the schema and import-analysis primitives needed for the first implementation.

This ADR is a migration-time authority rather than a permanent parallel documentation source. At the final architecture-enforcement phase, module-specific decisions move into the owning module's `docs/decisions.md`, and cross-module decisions move into `docs/architecture/decisions.md`. Context, trade-offs, rejected alternatives, and supersession history must survive that consolidation. After all references and traceability checks pass against those final owners, this ADR and the other fully absorbed ADR files are retired. `CONTEXT.md` remains a glossary and does not receive architecture rationale.
