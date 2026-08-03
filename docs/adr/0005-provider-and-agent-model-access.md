# Provider and agent model access

Model routing is an access policy, not a default-model or assignment system.
The configuration enables providers globally, then narrows each agent type to
specific providers and either all models or an exact model list.

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
  boundary, not a provider installer.
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
- Every other model requires routing ON, a globally enabled provider, an agent
  provider rule, a matching all/exact model rule, an exact
  `modelRegistry.getAvailable()` match, and active model scope authorization.
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
openai       All models
google       2 models
```

The Default row is not stored and cannot be disabled. The separator is the only
explanatory boundary before alternate access rules.

Normal Provider pickers are built from providers represented by
`modelRegistry.getAvailable()`, plus providers referenced by `enabledProviders`
or any saved agent access rule. The full `modelRegistry.getAll()` catalogue is
never exposed as ordinary provider choices. Rows are split into non-selectable
**Available providers** and **Saved but unavailable** sections. Provider origin
is not part of classification: a third-party provider reported by Pi is
available, while a built-in catalogue provider without availability is hidden
unless saved state keeps it manageable.

**Quick model setup** configures one agent against the current parent provider.
Applying it may enable model routing, enable the concrete current provider, and
write the agent/provider rule in one atomic operation. It writes the same
canonical state as the full provider and agent access menus; there is no second
quick-settings schema.

## Provider lifecycle

Disabling a provider or losing Pi availability suspends it without deleting
agent rules. Provider maintenance shows three separate facts: the user's routing
switch, whether Pi currently reports the provider through `getAvailable()`, and
whether provider-level alternate access is effective. Effective access requires
routing enabled and Pi availability. Saved rules are intersected with
availability and active scope at evaluation time; configuration is not rewritten
automatically.

Model editors contain currently available models plus saved exact IDs, so
provider or credential loss never makes a rule invisible or irremovable. The UI
distinguishes:

- **Active**: selected, Pi-available, in scope, and routed;
- **Available**: Pi-available for normal selection but not currently effective;
- **Out of current scope**: Pi-available but excluded by the current scope;
- **Provider unavailable**: saved under a provider absent from `getAvailable()`;
- **Unavailable catalogue ID**: a saved exact ID absent from a reliable
  `getAll()` snapshot while that catalogue provider is still present.

Only Unavailable catalogue IDs are eligible for **Clean unavailable rules**.
The provider-level action previews all affected agents and model IDs in one real
multi-line confirmation, then obtains a fresh `getAll()` snapshot before
mutation. It never derives candidates from `getAvailable()`, so credential loss,
provider unavailability, scope loss, and all-model rules cannot trigger cleanup.
If cleanup empties an exact model list, the provider entry is removed; empty
lists never become all-model access.

**Delete saved access rules** is the separate destructive action that removes a
provider from every agent policy, including policies for agent types that are no
longer registered. It does not change the provider's global enabled state.

## Dynamic parent guidance

The Agent tool remains schema-stealth, but current usage and access policy are
injected automatically with `before_agent_start`. The deterministic compact
system-prompt block is rebuilt from current agent types, parent model,
configuration, `getAvailable()` keys, and scope before each parent run. It does
not create a session message, trigger an extra turn, or require reload/manual
briefing.

Specific rules list exact available model keys; all-model rules use
`provider/*` only when that provider has an effective available model. Disabled,
catalogue-only, provider-unavailable, and out-of-scope models are not advertised
as callable.
The guidance states that alternate models require an explicit `model` argument
and that rejected explicit choices must not be replaced silently.

The Debug menu has no Agent briefing action. Existing agent-type and runtime
diagnostics remain UI-only.

## Accepted-work snapshots

The Agent call validates policy, Pi availability, and scope before accepting work, then
locks the selected model, parent model, thinking selection, and scope snapshot.
Running and queued agents use that invocation snapshot. Later policy edits,
provider disablement, rule deletion, parent-model changes, or scope changes
apply only to future Agent calls. Real provider credential or API failures may
still fail accepted work normally.

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
- Same-provider alternate models are explicit permissions, preventing parent
  provider changes from widening agent access silently.
- Provider disablement and Pi availability loss are reversible; dormant rules
  remain manageable, while catalogue-stale one-off rules can be cleaned or
  deleted explicitly.
- Accepted work is stable across later settings edits.
- Current model access reaches the parent LLM automatically without a manual
  briefing workflow.
