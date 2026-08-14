# Architecture decisions

This file is the final owner of cross-module decisions: their context, trade-offs, rejected alternatives, and supersession history. Module-specific rationale lives in each module's `docs/decisions.md`. The migration ADRs that first recorded these decisions were consolidated here and retired in Phase 9; the [refactoring plan](../refactoring-plan.md) and [migration baseline](./migration-baseline.md) remain the historical record of how the migration itself was run.

## Capability-oriented modular monolith

Before the refactor the implementation boundaries no longer matched the product concepts: at commit `37162c8` the four largest files held 3,955 of 10,275 source lines, the dependency audit found seven representative cycle paths, and `shell.ts` had fourteen importers connecting agent execution, delivery, configuration, and the TUI. Single classes owned unrelated state transitions and platform details, so replacing one host concern forced edits across policy, runtime, UI, and tests.

The codebase is a capability-oriented modular monolith. A module is one product capability that can be described, tested, and replaced independently; technical layers live inside the capability rather than as repository-wide folders. The capability modules are `agent-catalogue`, `model-access`, `subagent-runtime`, `background-result-delivery`, `child-screen`, and `settings`, with `prompt` and `configuration` as supporting modules. Each module may contain `application` (use cases through ports), `core` (pure policy), and `contracts` (TypeBox schemas and derived types), and exposes exactly one `public.ts` surface. Internal layers use direct imports, not barrels; architecture guards follow re-exports.

The import matrix: `contracts` and `core` never import Pi packages, Pi TUI, Node filesystem APIs, process globals, timers, or platform implementations. Module-external imports, including from platform implementations, go only through the target module's `public.ts`. `application` may import its own ports, `core`, and `contracts`. Platform implementations import that `public.ts` surface plus platform APIs; they do not import `ports/`. Only `bootstrap` constructs implementations and connects them.

Trade-off: explicit contracts and small orchestration modules mean more files, and platform adaptation is more deliberate because Pi objects cannot leak into application state. In return core behavior runs with in-memory ports and zero external services, tests need no internal module mocks, and feature work extends one vertical capability.

### Serializable boundaries

Every request, response, event, snapshot, and persisted value crossing a module, platform, or persistence boundary is JSON-serializable with a TypeBox schema; TypeScript types derive from those schemas. Calls inside one cohesive module use ordinary TypeScript types without repeated runtime validation. Pi objects such as `ExtensionContext`, `AgentSession`, TUI components, `AbortSignal`, timers, and filesystem handles stay inside their adapter, which exposes stable string IDs and serializable snapshots; cancellation and session progress cross ports as serializable commands and events.

### Enforcement

The architecture is mechanically enforced by zero-tolerance test guards: no import cycle (including type-only), no inward layer importing an outward layer, no platform packages in `contracts`/`core`/`application`, module-external imports only through `public.ts`, no `vi.mock` of internal modules, `globalThis` confined to `platform/process/process-state.ts`, valid repository-local documentation links, and every PRD requirement ID present in at least one test title. Size thresholds (400-line file, 60-line function) are review signals, not architectural proof; the ten-item S.U.P.E.R. checklist applies at review.

### Replaceability checks

The architecture is acceptable only while these changes keep the stated scope: replacing Pi with another host touches only the host adapter and bootstrap wiring; replacing Pi TUI touches only the UI adapter; replacing JSON-file configuration touches only the configuration document repository; replacing Pi child sessions touches only the session-driver adapter; replacing the scheduler touches only the scheduler component and its contract tests; replacing result persistence touches only the result repository adapter.

### Migration rule (historical)

The refactor ran in place on the `re` branch as behavior-preserving vertical slices: one contract, one failing public-seam test, the new path, and removal of the replaced path in the same slice — no parallel trees, compatibility layers, or fallback behavior. Two behavior corrections were approved, both of the same kind — a silent substitution replaced by an explicit outcome. Configuration persistence failure: a failed save returns an explicit failure and leaves the effective in-memory fragment unchanged instead of presenting a non-persisted mutation as current. Unavailable inherited prompt text: the run fails instead of silently continuing under the replace-mode header, because the inherited persona is the reason the mode was chosen and the condition is a host malfunction rather than a state the user can correct. Each phase ended with a batched formal review and a `Review-Result: PASS` checkpoint.

## Composition root over shared state

One `ExtensionRuntime` record (`bootstrap/extension-runtime.ts`) is created per extension activation; `registerTools(runtime)` and `setupEventListeners(runtime)` are the only registration paths, and every callback closes over that record. Ordinary session state is isolated between two runtimes in one process, pinned by `test/bootstrap/extension-runtime.test.ts`.

State that must survive a Pi Jiti reload is confined to `platform/process/process-state.ts` under a versioned `globalThis` symbol, with exactly two accepted responsibilities: the session-keyed fallback result inbox and the `AsyncLocalStorage` child-spawn marker that keeps extension imports inside a subagent inert without blocking an unrelated parent reload. Adding anything else there requires a concrete cross-reload need.

Supersession history: the original decision was a mutable module-level holder in `src/shell.ts`, because Pi invokes callbacks with fixed signatures and a small holder gave them one stable lookup point without exporting reassignable bindings that could go stale across Jiti imports. A closure-captured root was rejected at the time because callbacks were registered across separate handler modules; reassignable module bindings and positional dependency injection were rejected outright. Once registration was funneled through two entry points, the original objection to a closure-captured root stopped holding, and the Phase 8 cutover deleted `shell.ts`. The lasting cost of the holder era was visible in tests: every handler suite mocked `shell.js` instead of receiving dependencies.

## Stable stealth tool registration

The Agent, StopAgent, and AgentStatus tools are registered once at extension initialization with minimal schemas — no `description`, `promptSnippet`, or `promptGuidelines`, and mostly undescribed parameters — and the registered tool set never changes during the runtime's lifetime. Current Agent usage and model-access guidance reach the parent LLM through a deterministic `before_agent_start` system-prompt addition, never through a manual briefing command or injected conversation message.

Why: registering a tool mid-session rebuilds the system prompt, and llama.cpp renders tool definitions into prompt text through its Jinja2 chat template, so the token sequence changes and the KV-cache prefix is invalidated. Registration at initialization freezes the tool set from turn one. The access policy cannot live in the static schema because it depends on session state (discovered agent types, exact parent model, enabled providers, per-agent rules, registry and scope); the hook appends that state before each parent run without creating a message, triggering a turn, or requiring `/reload`.

Cache boundary: the prompt suffix changes only when effective authorization state changes, and must be byte-stable while state is unchanged. The guidance contract itself — what is advertised, exact-key enumeration, stable ordering — is owned by the [prompt module](../../src/modules/prompt/docs/decisions.md).

## Agent tool `worktree_path` naming

The Agent tool exposes `worktree_path` — the parent repository's main checkout or one of its linked git worktrees sharing the parent's resolved `git-common-dir` — rather than a generic `cwd`. In a stealth-tool design the parameter name is the only documentation the LLM sees at call time; a generic name teaches the constraint through a failed spawn, costing a turn per mistake.

Rejected alternatives: `cwd` (contradicts the stealth principle that the schema name is the documentation), `path_to_worktree` (no information gain, longer), `worktree_cwd` (category mismatch: "worktree" is a path concept, "cwd" a session concept). Trade-off: the name is single-purpose; if a future feature must target arbitrary directories, a separate less-restricted parameter is cheap to add later.

## Configuration precedence

Operational settings resolve through the `configuration` support module with the precedence: environment variables, then `.env` values, then a configured file value when the setting can have one, then defaults owned by the consuming capability. The home directory is the only operational setting today, and it receives only three candidates — environment, `.env`, and the OS home fallback. The persisted configuration file cannot apply: the document's own location derives from this value, so it cannot locate itself. Timeouts, retention, cleanup, teardown, and concurrency defaults are capability-owned constants in the runtime; they are not read from the environment, `.env`, or the document. Extending the resolver to those values requires a separate decision and must not introduce unused environment variables. Interactive product policies such as Model access and Thinking access are owned by persisted capability fragments and receive no implicit environment override; defining one requires a separate decision with explicit user-interface semantics.

The owning capability validates and computes a proposed fragment, then requests an atomic transaction; only a successful commit becomes the current in-memory snapshot, and failure leaves all consumers unchanged with an explicit error. There is no configuration-change event bus and no configuration service that calls runtime or UI objects. The persisted `subagents-lite.json` keeps its unversioned physical shape with `modelRouting`, `agent`, and `concurrency` sections; the in-memory document revision orders transactions but is never written to disk. Changing the physical format requires a separate approved product change — no dual-format reader, no migration layer.
