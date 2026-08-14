# Model access decisions

## Current

- Model access is explicit authorization, not automatic routing, model assignment, or Provider installation. `enabledProviders` is an authorization boundary, not an installer.
- One effective policy snapshot is the source for runtime authorization, Agent guidance, and settings projections.
- Authorization and Thinking decisions enter through `model-access/public.ts`. Callers translate Pi availability, scope, and supported Thinking levels into serializable inputs.
- Parent model access is a per-agent policy. An omitted `parentModelAccess` means allowed; denial makes an omitted `model` fail immediately, and explicitly passing the exact parent key fails too — no alternate is ever selected automatically, because silent substitution was the original design's core defect.
- The Agent tool accepts only exact canonical `provider/model` keys, and Thinking only Pi's canonical levels through the separate `thinking` argument. A rejected explicit model or Thinking value is reported with the allowed set, never silently clamped or replaced.
- Saved Thinking overrides follow the exact model across Parent-default and alternate roles and stay dormant while the model is not callable. Without an override, a Parent default inherits the parent session's effective thinking and an alternate defaults to Pi's `clampThinkingLevel(model, "high")`; a Pi Model scope pin replaces both the allowed set and the default.
- An omitted `models` property in a provider rule means every model Pi currently or later reports available for that provider — not the full built-in catalogue. An empty array is invalid and removes the rule; it must never widen into all-model access.
- Disabling a Provider or losing Pi availability suspends rules without deleting them; dormant rules reappear when their prerequisite returns. Deletion is always an explicit user action (the unavailable-provider exception flow, or catalogue-proven `Clean unavailable rules`), never a side effect of evaluation.
- The accepted-work snapshot locks definition, policy, model, parent model, thinking, scope state, output limit, and grace turns when an Agent call is accepted; later policy edits, provider changes, or scope changes affect only future calls.
- Frontmatter `max_tokens` is a runtime output limit applied to a child-only copy of the selected model, never a routing permission or a mutation of the registry or parent model object.
- Canonical model keys, host-supplied scope snapshots, and authorization error text live in this module so bootstrap and the Pi adapter share one owner instead of a third `src/models` tree.

## Superseded

- Assignment precedence, queue revalidation, implicit alternate selection, and global Thinking defaults are retired. The [decision tables](./decision-tables.md) are the sole module authority for saved, effective, unavailable, dormant, scope, and Thinking combinations.
- The pre-refactor design stored one automatic model assignment per agent type with session and persistent precedence ahead of frontmatter. That conflated routing enablement, global provider availability, and per-agent authorization, made an omitted `model` ambiguous, made provider removal destructive, and let policy edits invalidate queued work. Explicit allowlists, dormant suspension, and acceptance-time snapshots each answer one of those failures.
- Unconditional Parent-default access and the current-parent Provider's global-gate bypass are superseded by explicit Parent model access policy; the parent Provider passes no gate that other providers must pass.
- Bare model IDs, `model:thinking` suffixes, the global `defaultThinking` setting, and Agent frontmatter `thinking` are retired without a compatibility precedence layer. Persisted `agent.defaultThinking` is silently dropped at load; a frontmatter `thinking` field is ignored with an explicit warning.

## Implementation-only

- Settings row IDs, page encodings, and the bootstrap owner's verb names are not policy terms.
