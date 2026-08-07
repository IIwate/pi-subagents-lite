# Module-level shell holder for runtime state

## Status

Accepted.

## Decision

`src/shell.ts` owns one mutable holder for each imported extension runtime. Pi's
fixed-signature callbacks access current services through `getStore()`,
`getManager()`, `getNavigator()`, `getCoordinator()`, and the corresponding
setters instead of importing reassignable state bindings from multiple modules.

The shell creates its `ConfigStore` with the extension runtime. The manager,
spawn coordinator, navigator, and session context are attached during
`session_start`; `session_shutdown` disposes their owned resources and clears
the references. Domain state remains inside the service that owns it rather
than accumulating on the shell.

Only state that must cross a Jiti reload is process-local under a versioned
`globalThis` symbol:

- fallback result buckets keyed by parent session ID;
- an `AsyncLocalStorage` marker identifying the child-spawn async chain.

The marker makes extension imports inside a subagent inert without blocking an
unrelated parent reload. All other runtime state is recreated normally.

## Why

Pi invokes tool and lifecycle callbacks with signatures the extension cannot
change. A small module-level holder gives those callbacks one stable lookup
point without exporting mutable `let` bindings whose consumers may retain stale
values across Jiti imports.

Keeping the holder narrow also preserves ownership boundaries: configuration
and persistence live in `ConfigStore`, execution records live in
`AgentManager`, delivery coordination lives in `SpawnCoordinator`, and TUI
state lives in `AgentNavigator`.

## Trade-off

Handler modules depend on `shell.ts`, so tests mock that module rather than
receiving every service as a positional parameter. Runtime access is also
lifecycle-dependent: session services must be attached before a callback reads
them and must not be reused after shutdown.

The process-local handoff and async marker deliberately outlive one imported
runtime. Adding anything else to that global object requires a concrete
cross-reload need; ordinary configuration, manager, coordinator, and UI state
must remain runtime-local.

## Considered options

- **Closure-captured composition root.** Rejected because callbacks are
  registered across separate handler modules and still need a shared lookup
  point; wrapping every registration only moves the holder into more closures.
- **Export reassignable module bindings.** Rejected because consumers can retain
  stale values across Jiti imports and ownership becomes distributed.
- **Request-scoped positional dependency injection.** Rejected because Pi owns
  the callback signatures and provides no parameter for extension services.
