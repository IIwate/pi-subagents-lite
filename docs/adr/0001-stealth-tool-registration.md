# Stealth tool registration with dynamic guidance

The Agent tool is registered at extension initialization with a minimal schema:
no `description`, no `promptSnippet`, no `promptGuidelines`, and mostly
undescribed parameters. Registration remains stable for the lifetime of the
extension runtime.

The parent LLM receives current Agent usage and model-access guidance through a
deterministic `before_agent_start` system-prompt addition. There is no manual
Agent briefing command or injected conversation message.

## Why

Registering the Agent tool lazily calls `registerTool()` → `refreshTools()` →
`setActiveToolsByName()` and rebuilds the system prompt. llama.cpp renders tool
definitions into prompt text through its Jinja2 chat template, so adding a tool
mid-session changes the token sequence and invalidates the KV-cache prefix.

Registering at initialization freezes the tool set from turn one. No dynamic
tool registration or active-tool replacement is needed for model-routing
configuration changes.

The access policy cannot live only in the static tool schema because it depends
on current session state:

- discovered agent types;
- the exact parent model;
- globally enabled routed providers;
- per-agent provider/model rules;
- the current model registry and active scope.

Pi's `before_agent_start` hook can append that state to the system prompt before
each parent run without creating a message, triggering an extra turn, or
requiring `/reload`. Configuration or parent-model changes are therefore visible
to the next parent run automatically.

## Guidance contract

The injected block is compact, deterministic, and present only while the Agent
tool is active. It includes:

- available agent types and the critical Agent invocation rules;
- the exact parent model, selected by omitting `model`;
- exact effective alternate model keys for restricted and all-model rules;
- the requirement to pass one listed canonical key as `model` for alternate access;
- the rule that rejected explicit models are never replaced silently.

Disabled providers, unavailable models, and out-of-scope models are not
advertised as callable. Unconfigured agents are summarized as parent-model
only. Stable sorting keeps the prompt suffix identical while effective state is
unchanged.

## Cache boundary

The system-prompt suffix changes when the effective access policy, parent model,
registry, scope, or agent catalogue changes. That change may invalidate a prompt
cache prefix, but it reflects real authorization state and occurs without
changing the registered tool set. When state is unchanged, the generated suffix
must be byte-stable.

## Trade-off

The minimal tool schema still requires system-prompt guidance for reliable use.
Automatic per-run injection adds a prompt suffix, but removes stale manual
briefings and user refresh steps. All-model rules enumerate the current effective
`getAvailable()` and scope intersection because the Agent tool requires a
concrete model key; catalogue-only and otherwise unauthorized models remain
excluded.

The Debug menu keeps agent-type and runtime diagnostics but has no Agent
briefing action. Guidance is runtime behavior, not a user-maintained message.
