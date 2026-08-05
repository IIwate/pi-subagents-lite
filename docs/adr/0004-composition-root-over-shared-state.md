# Composition root over module-level shared state

Shared runtime state (config, session overrides, the activity store, the manager,
pi instance, and session context) lives on a single composition-root
**shell** object that PI's fixed-signature callbacks capture by closure, rather
than as module-level mutable `let`/`Map` bindings exported from `state.ts`.
Per-session services (config store, agent manager, spawn coordinator, navigator)
are constructed at `session_start` and mounted onto the shell; `session_shutdown`
disposes them. Owned domain state moves into the module that owns the concern:
config into the ConfigStore, result persistence and parent wake coordination
into the spawn coordinator.

## Why

Three problems forced this. First, the PI runtime invokes tool `execute`
callbacks and event handlers (`tool_call`, `session_start`, `session_shutdown`)
as plain closures with signatures it dictates; they cannot take extra
parameters, so dependencies must be reachable from inside them somehow. A shell
captured by closure is the cleanest way and reaches every callback.

Second, `state.ts`'s own header warns that the PI runtime does not propagate
ESM live-binding reassignments, so manager and UI state already used holder
objects rather than `let` re-exports. But `__config` *was* a `let` re-export
reassigned on every `setConfig()` — the exact stale-reference footgun the header
describes. A shell with fields removes live-binding reassignment entirely; the
closure always reads the current field.

Third, the module-level globals forced every test of a tool execute handler to
mock 15+ modules, because the handlers' real dependencies (config, manager,
pi, session context) were invisible in their signatures. Capture-by-closure
makes those dependencies real parameters of the handler (captured, not
positional), so a test substitutes one shell (or one service) instead of mocking
the world.

The shell is a composition root, not a god object: it is small (~the surviving
holder functions), survives across sessions, and owns nothing itself. Owned
domain state sits on the per-session services.

## Trade-off

Closures capture the shell at registration time (factory load), but the
per-session services are only populated at `session_start`. This reintroduces a
temporal coupling: a callback firing before the first `session_start` would see
unpopulated fields. In practice every callback that reads session services fires
during or after `session_start`, and `session_shutdown` disposes them, so the
shell fields are populated exactly when they're read. The contract is "callbacks
run inside a session" — true for all current handlers. It must be upheld when
adding new event handlers.

The shell is a process-local singleton for the lifetime of the extension. That's
acceptable here (one extension instance per pi process) but would be wrong in a
multi-instance setting. If pi ever ran multiple extension instances in one
process, the shell would need to become per-instance.

## Considered Options

- **Keep `state.ts` as a module-level singleton namespace.** Rejected: leaves
  the stale-`let` footgun for `__config`, keeps the 15-mock test pattern, and
  the "read directly, write via setter" contract stays an unenforced convention.
- **Per-handler dependency injection via a request-scoped context.** Rejected:
  PI's callback signatures don't accept extra parameters, so there is nowhere to
  inject per-call. Closure capture is the only injection mechanism available.

## Decision change (2026-02)

The implementation landed as a module-level mutable holder singleton
(`shell.ts`: `getStore()` / `setManager()` and sibling getter/setters), not the
closure-captured composition root described
above. Tests still
`vi.mock` the whole `shell.js` module (`test/fixtures.ts` `shellMock`,
`test/menu-mock-setup.ts`).

Why: pi's callback signatures still require a holder reachable from module
scope. Pi loads extensions through Jiti with module caching disabled, so that
holder is per imported runtime rather than one permanent process module.
Fields are read through getters, never re-exported bindings, while tests accept
the whole-module shell mock pattern the original decision rejected.

Effect: the shell stays small and owns no domain state; per-session services are
constructed at `session_start` and disposed at `session_shutdown`. The two
pieces that must cross a Jiti reload are explicitly process-local instead: the
same-session result fallback and an `AsyncLocalStorage` child-spawn marker. The
marker follows only the child async chain, so a concurrent parent reload is not
made inert. The "composition root" wording in this ADR should be read as
"single holder for one imported session runtime", not closure injection.
