# pi-subagents-lite

A lightweight pi extension that lets the LLM spawn autonomous child agents for complex tasks. Focused fork of pi-subagents with reduced surface area — no scheduling, no join modes.

## Language

### Core concepts

**Subagent**:
An autonomous child agent spawned from the parent conversation via the Agent tool.
_Avoid_: Child agent, worker, task agent

**Agent type**:
A named configuration (general-purpose, Explore, or custom) defining a subagent's tools, skills, system prompt, thinking, and runtime limits.
_Avoid_: Agent kind, agent class

**Agent guidance**:
A compact deterministic system-prompt block added automatically with `before_agent_start`. It teaches the parent LLM the available agent types, critical Agent tool rules, the exact parent default model, and currently effective alternate model access. It is not a session message and requires no manual refresh.
_Avoid_: Agent briefing, agent documentation, tool description

**Stealth tool**:
A tool registered at extension initialization with no description, promptSnippet, or promptGuidelines. The stable tool set preserves prompt-cache behavior; current usage and access rules come from dynamic Agent guidance.
_Avoid_: Hidden tool, minimal tool

### Configuration

**Model routing**:
The policy that controls access to models other than the exact parent model. OFF allows only the exact parent model. ON enables globally routed providers and per-agent model access rules. Configured via `/agents` > Settings > Model routing.
_Avoid_: Cross-provider routing, model assignment

**Parent default**:
The exact model active in the parent session when the Agent call is accepted. Omitting `model`, or explicitly passing the same model key, selects it. It is always available, dynamically displayed as a locked Default row, and never persisted in routing configuration.
_Avoid_: Global default, inherited assignment

**Model access rule**:
A persistent authorization for one agent type to use one provider. An omitted `models` property means all currently available models from that provider; a non-empty array means only those exact model IDs. Empty arrays are invalid and removed. Alternate models must be passed explicitly through the Agent tool.
_Avoid_: Model assignment, model override, model preference

**Dormant provider rule**:
A saved Agent/provider access rule whose provider is globally disabled. Disabling a provider preserves these rules; re-enabling restores the subset still valid in the current registry and scope.
_Avoid_: Stale assignment, disabled model

**Unavailable model rule**:
A saved exact model ID absent from a reliable current registry snapshot for a provider that is present. It may be batch-removed by Clean unavailable rules. A model that merely falls outside the current scope is not unavailable.
_Avoid_: Out-of-scope model, disabled model

**Model scope**:
The active allowlist of models from pi (`--models`, `enabledModels`, or `/scoped-models`). A routed model must be inside this scope. Empty/unset scope means unrestricted. Scope affects effective access but never makes a saved rule eligible for stale-rule cleanup.
_Avoid_: Enabled models list, model filter

**Quick model setup**:
The short UI path for granting one agent type alternate access to models from the current parent provider. It writes the same canonical `enabledProviders` and `agentAccess` state as the full menus; no separate quick-settings schema exists.
_Avoid_: Quick assignment, quick default

**Grace turns**:
Additional turns allowed after the soft turn limit steer message before hard abort. Default 6, configurable via `/agents` > Settings > Spawn options.
_Avoid_: Grace period, extra turns

### Worktrees

**Worktree**:
A linked git worktree of the same repository as the parent, distinguished by its `--git-dir` pointing outside the worktree root. The target of the `worktree_path` Agent tool param.
_Avoid_: Git worktree, sibling worktree

**Worktree path**:
The resolved absolute filesystem path passed through `worktree_path`. Used as the subagent's working directory for its session, resource loader, and system prompt.

### Runtime

**Invocation snapshot**:
The model, parent model, thinking selection, and scoped-model state locked after an Agent call passes authorization. Running and queued agents use this snapshot; later configuration, parent-model, or scope changes affect only future calls.
_Avoid_: Queue revalidation, live assignment

**Nudge**:
A completion notification delivered to the parent session after a background agent finishes. Batched with a 200ms hold to coalesce rapid completions.
_Avoid_: Callback, notification

## Relationships

- An **Agent type** may have multiple **Model access rules** across multiple providers
- A **Subagent** is spawned from one **Agent type**
- Every **Subagent** can use the dynamic **Parent default**
- An alternate model must satisfy global provider, Agent/provider, Agent/model, registry, and **Model scope** checks
- **Quick model setup** writes the same rules as the full model-access menus
- A disabled provider leaves **Dormant provider rules** intact
- An **Unavailable model rule** can be batch-cleaned; an out-of-scope rule cannot
- Accepted running and queued work uses an **Invocation snapshot**
- **Agent guidance** communicates current effective access to the parent LLM before each run
- A **Subagent** may run in a **Worktree** of the parent's repository
- A **Nudge** is emitted when a background agent completes or errors
- **Grace turns** are added to the max-turn limit before a steered agent is hard-aborted

## Product boundaries

- The `Agent` tool is the only spawn entry point. `/agents` owns settings and diagnostics, not a second user-driven spawn flow. Revisit only if users need to start agents without involving the parent LLM.
- Model routing is authorization, not provider installation and not automatic model selection. Omitted `model` always means the exact parent model; rejected explicit choices never fall back silently.
- Provider disablement is reversible. Destructive cleanup is limited to explicit Clean unavailable rules, Delete saved access rules, and Clear routing settings actions.
- Configuration changes apply immediately to future Agent calls. Running and queued calls retain their invocation snapshot; users stop accepted work explicitly through StopAgent.
- A failed subagent with a settled in-memory session remains available for the existing list-driven user interaction flow for 30 minutes, or until manual clear or parent shutdown. The recovery countdown freezes while that child view is active and resumes from its remaining duration on return to Main; this prevents an expiry-triggered screen swap while the user is inspecting the session. This is not persisted resume, and the parent LLM does not receive a continuation tool.
- Debug may arm a session-local, one-shot fault for the next Agent that actually starts. Queued records do not reserve or consume it. Injection happens after the real child session is configured and before its first provider prompt, with a fixed 10-second recovery window; ordinary recoverable failures keep 30 minutes. Debug is UI-only, is not persisted across reload, does not create a provider probe or second spawn path, and exposes neither diagnostics nor lifecycle control to the parent LLM.
- Recoverable-failure presentation is local-only. External transports such as webhooks, Telegram, and email are deferred until a concrete consumer exists; future notifications must not include prompts, transcripts, source code, or findings by default.
- Input usage accumulates provider-reported values without a vLLM-specific delta heuristic. Revisit only when a supported backend demonstrably reports cumulative prompt tokens without usable cache accounting.

## Tests

- `bun run test` runs the complete suite; GitHub Actions executes it on Ubuntu.
