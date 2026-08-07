# Provider and agent model access

Model routing is an access policy, not a default-model or assignment system.
The configuration enables alternate providers globally, while the current
parent provider dynamically passes that one gate, then narrows each agent type
to specific providers and either all models or an exact model list.

## Context

The previous design stored one automatic model assignment per agent type, with
session and persistent precedence ahead of agent frontmatter. That conflated
three concerns:

- whether alternate model routing was enabled;
- which providers were globally available for routing;
- which provider/model combinations an agent type was authorized to use.

It also made omission of the Agent tool's `model` argument ambiguous: omission
could activate an assignment or frontmatter model instead of inheriting the
parent model. Provider removal was destructive, and queued work could be
invalidated by policy edits made after the Agent call had already been
accepted.

## Decision

The canonical configuration is:

```json
{
  "modelRouting": {
    "enabled": true,
    "enabledProviders": ["anthropic", "openai", "google"],
    "agentAccess": {
      "Explore": {
        "providers": {
          "anthropic": { "models": ["claude-haiku-4"] },
          "openai": {},
          "google": {
            "models": ["gemini-2.5-pro", "gemini-2.5-flash"]
          }
        }
      },
      "reviewer": {
        "providers": {
          "openai": { "models": ["o3"] }
        }
      }
    }
  }
}
```

- `modelRouting.enabled` controls alternate model routing. OFF permits only the
  exact parent model.
- `enabledProviders` is the global routed-provider set. It is an authorization
  boundary, not a provider installer. The current parent provider dynamically
  passes only this gate while it remains the parent, even if it is absent from
  the set.
- `agentAccess[agent].providers[provider]` grants one agent type access to that
  provider.
- An omitted `models` property means every model Pi currently or later returns
  from `modelRegistry.getAvailable()` for the provider. It does not include
  unauthenticated entries from the full built-in catalogue. A non-empty array
  means only those exact model IDs. An empty array is invalid and removes the
  provider rule; it must never become all-model access.
- The exact parent model is always available. It is dynamic session state, not
  persisted policy. Omitting `model`, or explicitly passing the exact same
  model key, selects it.
- Every other model requires routing ON, an agent provider rule, a matching
  all/exact model rule, an exact `modelRegistry.getAvailable()` match, active
  model scope authorization, and an explicit Agent tool `model` argument. Its
  provider must also be globally enabled unless it is the current parent
  provider. Parent-provider alternates receive no other bypass.
- A rejected explicit model is never replaced silently with the parent model.
- Agent frontmatter does not select a model automatically. If the frontmatter
  `model` field has no remaining consumer, it is removed rather than retained
  as dead configuration.

## User interface

The setting is named **Model routing**, not Cross-provider routing, because it
also controls alternate models from the current parent provider.

Each agent access page starts with a locked dynamic row:

```text
[✓] Default · anthropic/claude-sonnet-4
────────────────────────────────────────
anthropic · Parent alternates
openai
google
```

The Default row is not stored and cannot be disabled. The separator is the only
explanatory boundary before alternate access rules.

**Provider access** is a single-purpose direct switch list rebuilt from
`modelRegistry.getAvailable()` whenever it opens or toggles. It contains a
locked Default row, exactly one separator, and checkbox rows for current
available providers except the current parent provider. There is no Available
providers heading, Provider detail page, availability/effective diagnostics,
or zero rule-count text. Enter or Space toggles a provider in place and keeps
the cursor on that provider. If no alternate provider is available, one concise
non-actionable empty row follows the separator. The top summary counts enabled
providers visible as mutable switches, excluding unavailable providers and the
current parent even when that parent is redundantly persisted.

The full `modelRegistry.getAll()` catalogue is never exposed as ordinary
provider choices. After an Agent is selected, its Provider picker further
intersects Pi availability with enabled Provider access, then adds the current
parent provider as the explicit `Parent alternates` exception. Disabled and
unavailable providers are hidden while their rules remain dormant. Provider
origin is irrelevant: built-in and third-party providers are treated alike when
Pi reports them available.

**Quick model setup** configures one agent against the current parent provider.
Each checkbox change persists immediately. Adding access enables model routing,
enables the concrete current provider, and writes the agent/provider rule through
the same canonical mutation; removing the final selection deletes only that
Agent rule. There is no Apply row or second quick-settings schema.

## Provider lifecycle

Disabling a provider or losing Pi availability suspends it without deleting
agent rules. Saved state referencing providers absent from `getAvailable()` is
counted in the conditional **Saved unavailable providers** top-level row,
excluding the current parent provider. Its separate exception flow shows only
the provider, dormant routing ON/OFF, and a non-zero Agent rule count. It offers
only routing toggle and explicit deletion of all saved access rules with a real
multiline confirmation. Toggling never deletes rules. There is no ordinary
Provider maintenance/detail page and no compatibility entry path to one.

Saved rules are intersected with routing, current-parent provider gate,
availability, model permission, explicit-model use, and active scope at
evaluation time; configuration is not rewritten automatically.

For a Provider that passed the effective gate, the model editor exposes only
actionable alternates: current `getAvailable()` models intersected with Pi's
active model scope, excluding the exact parent model. An empty scope means the
usual unrestricted Pi inventory. The UI does not list excluded models with
status text; scope configuration is a Pi prerequisite rather than an extension
workflow.

In the normal Agent editor, `All models` and exact-model checkboxes persist immediately, keep the editor
open, and retain the cursor on the changed row. There is no Apply row and no
`Use exact model rules`, Active, Available, or Out-of-scope diagnostic text.
When no actionable alternate remains, one concise empty row replaces the model
choices.

Saved exact IDs outside the visible intersection remain dormant in canonical
configuration. Editing a visible checkbox preserves those hidden IDs; they
reappear automatically if Pi availability and scope admit them again. Runtime
scope validation remains mandatory because configuration and direct Agent tool
calls are not constrained by the TUI. Disabling or losing a Provider likewise
hides it without deleting its rules; unavailable-provider deletion remains in
the separate exception flow.

Only Unavailable catalogue IDs are eligible for the conditional global
**Clean unavailable rules** action. Candidates may come from enabled or dormant
provider rules, but only when `getAll()` is reliable and still contains the
provider. The multiline confirmation lists every affected Provider, Agent, and
model ID. Confirmation re-reads and recomputes the catalogue, then removes only
IDs still unavailable. It never derives candidates from `getAvailable()`, so
credential loss, provider unavailability, scope loss, and all-model rules cannot
trigger cleanup. If cleanup empties an exact model list, the provider entry is
removed; empty lists never become all-model access.

**Delete saved access rules** exists only in the saved-unavailable exception
flow and removes a provider from every agent policy, including policies for
agent types that are no longer registered. It does not change the provider's
global enabled state.

## Dynamic parent guidance

The Agent tool remains schema-stealth, but current usage and access policy are
injected automatically with `before_agent_start`. The deterministic compact
system-prompt block is rebuilt from current agent types, parent model,
configuration, `getAvailable()` keys, and scope before each parent run. It does
not create a session message, trigger an extra turn, or require reload/manual
briefing.

Every effective alternate is listed as an exact canonical `provider/model` key,
including models admitted by an all-model rule. Wildcards are never advertised
because the Agent tool requires a concrete model argument. The current parent
provider bypasses only the global provider set in this guidance, matching
runtime authorization. Routing-OFF, missing Agent/provider rules,
model-denied, catalogue-only, provider-unavailable, implicit alternate, and
out-of-scope models are not advertised as callable.
The guidance states that alternate models require an explicit `model` argument
and that rejected explicit choices must not be replaced silently.

The Debug menu has no Agent briefing action. Existing agent-type and runtime
diagnostics remain UI-only.

## Accepted-work snapshots

The Agent call validates policy, Pi availability, and scope before accepting work, then
locks a deep-copied Agent definition, resolved tool/skill/extension policy,
system prompt mode, context-file setting, selected model, parent model, thinking
selection, scoped-model state, and grace turns. Running and queued agents use
that accepted run policy without consulting the mutable registry or config
store at start time. `inherit` captures the mode while Pi supplies the parent
system prompt text at actual start. Later policy edits, provider disablement,
rule deletion, parent-model changes, or scope changes apply only to future
Agent calls. Real provider credential or API failures may still fail accepted
work normally.

## Migration

Pre-2.0 and assignment-based routing shapes are not supported. The following
fields are neither read nor migrated:

- `allowCrossProvider`;
- `allowedProviders`;
- `agentModels`;
- dynamic `agent[<type>]` model keys;
- `agent.default`;
- session model assignments;
- Agent frontmatter `model`.

A missing or malformed `modelRouting` block falls back to routing OFF with no
enabled providers or agent access. Non-model agent and concurrency settings
continue to load normally. The next explicit save writes only the canonical
schema.

## Consequences

- Omitted `model` has one meaning: exact parent inheritance.
- Same-provider alternate models are explicit permissions. Parent changes move
  only the dynamic global-gate exception; they do not bypass Agent/model,
  availability, scope, explicit-model, or routing checks.
- Provider disablement and Pi availability loss are reversible. Daily Provider
  access remains diagnostic-free, dormant exceptions remain manageable, and
  catalogue-stale one-off rules can be cleaned or deleted explicitly.
- Accepted work is stable across later settings edits.
- Current model access reaches the parent LLM automatically without a manual
  briefing workflow.
