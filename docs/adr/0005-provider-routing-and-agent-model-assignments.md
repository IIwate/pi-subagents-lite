# Provider routing and agent model assignments

The mixed "model settings" design is split into three concepts: the routing
switch, the allowed-provider allowlist, and per-agent model assignments. The
legacy `Global default model` and `Per-type overrides` terminology is removed.

## Context

The previous config mixed concerns in one place: `allowCrossProvider` toggled
permission, `agent.default` was a global default, and dynamic `agent[<type>]`
string keys held per-type overrides. That made "what model does this agent
use?" depend on implicit precedence rules and left no way to authorize *which*
extra providers are acceptable.

## Decision

New config shape, `modelRouting`:

```json
{
  "modelRouting": {
    "enabled": true,
    "allowedProviders": ["openai", "google"],
    "agentModels": {
      "Explore": "openai/gpt-4o",
      "reviewer": "google/gemini-2.5-pro"
    }
  }
}
```

- `modelRouting.enabled` — routing switch. OFF is strict: subagents use the
  exact parent model; session/persistent assignments, agent frontmatter
  models, and explicit Agent-tool models are ignored (even same-provider
  ones). ON enables the precedence chain below.
- `modelRouting.allowedProviders` — persistent allowlist of extra providers.
  The parent provider is implicit: never written to the list, never
  toggleable, and its models are always selectable when routing is ON.
- `modelRouting.agentModels` — persistent per-agent-type model assignments.
  Assignments are shared by all agents of the same type by default.
- `agent` keeps only real agent settings (background, thinking, prompt,
  display); no dynamic model keys.
- `CONFIG_AGENT_NON_MODEL_KEYS` is deleted.

ON precedence: explicit Agent-tool model → session assignment → persistent
assignment → agent frontmatter model → parent model. Every non-parent model
must satisfy `provider === parent.provider` or `provider ∈ allowedProviders`,
and must be inside Pi's active model scope. Provenance stays explicit /
automatic / parent; queued agents re-validate routing, allowlist, and scope at
start and fail loudly when permission was revoked — never silently swap.

Removing an allowed provider that has assignments requires confirmation and
clears the affected persistent and session assignments in one step; running
agents are unaffected, queued agents fail at start.

## Migration

One-time, no long-lived compatibility: `allowCrossProvider` → `enabled`; old
dynamic `agent[<type>]` keys → `agentModels` with their providers extracted
into the allowlist; `agent.default` is dropped with a warning (no successor
semantics — unassigned agents inherit the parent model). Old model fields are
pruned from the persisted config on the next explicit save.

## Consequences

- OFF is a hard guarantee: no model other than the exact parent model can run.
- The allowlist is a permission boundary, not an installer — it authorizes
  providers Pi already has configured, it does not enable plugins.
- Saved providers missing from the current model registry/scope are shown as
  unavailable and can be removed.
- The model selector filters to parent + allowed providers with
  `(inherits parent)` always last.
