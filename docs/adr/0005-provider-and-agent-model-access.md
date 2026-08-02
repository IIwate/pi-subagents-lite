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
- An omitted `models` property means all currently available models from the
  provider. A non-empty array means only those exact model IDs. An empty array
  is invalid and removes the provider rule; it must never become all-model
  access.
- The exact parent model is always available. It is dynamic session state, not
  persisted policy. Omitting `model`, or explicitly passing the exact same
  model key, selects it.
- Every other model requires routing ON, a globally enabled provider, an agent
  provider rule, a matching all/exact model rule, a registry match, and active
  model scope authorization.
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

**Quick model setup** configures one agent against the current parent provider.
Applying it may enable model routing, enable the concrete current provider, and
write the agent/provider rule in one atomic operation. It writes the same
canonical state as the full provider and agent access menus; there is no second
quick-settings schema.

## Provider lifecycle

Disabling a provider suspends it without deleting agent rules. Re-enabling the
provider restores only rules that are currently effective. Saved rules are
intersected with the registry and active scope at evaluation time; configuration
is not rewritten automatically.

The UI distinguishes:

- **Active**: present in the registry, in scope, and authorized;
- **Out of scope**: present in the registry but excluded by the current scope;
- **Provider disabled**: saved under a globally disabled provider;
- **Unavailable**: a saved exact model ID is absent from a reliable current
  registry snapshot for a provider that is present.

Only Unavailable exact model rules are eligible for **Clean unavailable
rules**. The provider-level action previews all affected agents and model IDs in
one real multi-line confirmation. It never removes out-of-scope rules, disabled
provider rules, or all-model rules. If cleanup empties an exact model list, the
provider entry is removed; empty lists never become all-model access.

**Delete saved access rules** is the separate destructive action that removes a
provider from every agent policy, including policies for agent types that are no
longer registered. It does not change the provider's global enabled state.

## Dynamic parent guidance

The Agent tool remains schema-stealth, but current usage and access policy are
injected automatically with `before_agent_start`. The deterministic compact
system-prompt block is rebuilt from current agent types, parent model,
configuration, registry, and scope before each parent run. It does not create a
session message, trigger an extra turn, or require reload/manual briefing.

Specific rules list exact model keys; all-model rules use `provider/*`.
Disabled, unavailable, and out-of-scope models are not advertised as callable.
The guidance states that alternate models require an explicit `model` argument
and that rejected explicit choices must not be replaced silently.

The Debug menu has no Agent briefing action. Existing agent-type and runtime
diagnostics remain UI-only.

## Accepted-work snapshots

The Agent call validates policy, registry, and scope before accepting work, then
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
- Provider disablement is reversible; stale one-off rules can be cleaned or
  deleted explicitly.
- Accepted work is stable across later settings edits.
- Current model access reaches the parent LLM automatically without a manual
  briefing workflow.
