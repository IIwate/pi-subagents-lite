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
A compact deterministic system-prompt block added automatically with `before_agent_start`. It teaches the parent LLM the available agent types, critical Agent tool rules, the exact parent default model, and every currently effective alternate as an exact canonical model key. It never substitutes wildcard policy summaries for callable arguments, is not a session message, and requires no manual refresh.
_Avoid_: Agent briefing, agent documentation, tool description

**Stealth tool**:
A tool registered at extension initialization with no description, promptSnippet, or promptGuidelines. The stable tool set preserves prompt-cache behavior; current usage and access rules come from dynamic Agent guidance.
_Avoid_: Hidden tool, minimal tool

### Configuration

**Model routing**:
The policy that controls access to models other than the exact parent model. OFF allows only the exact parent model. ON applies Provider access switches and per-agent model access rules; the current parent provider dynamically passes only the global Provider access gate. Configured via `/agents` > Settings > Model routing.
_Avoid_: Cross-provider routing, model assignment

**Provider access**:
The direct mutable switch list for available alternate providers. It excludes the current parent provider, which dynamically passes this gate, and never includes unavailable saved state or Provider diagnostics.
_Avoid_: Enabled providers, Provider maintenance

**Saved unavailable provider**:
A provider referenced by saved routing state but absent from current Pi availability, excluding the current parent provider. It is managed only through the conditional exception flow.
_Avoid_: Unavailable Provider access switch, Provider diagnostic

**Parent default**:
The exact model active in the parent session when the Agent call is accepted. Omitting `model`, or explicitly passing the same model key, selects it. It is always available, dynamically displayed as a locked Default row, and never persisted in routing configuration.
_Avoid_: Global default, inherited assignment

**Model access rule**:
A persistent authorization for one agent type to use one provider. An omitted `models` property means all currently available models from that provider; a non-empty array means only those exact model IDs. Empty arrays are invalid and removed. The Agent Provider picker exposes only globally enabled, Pi-available providers plus the current parent provider; hidden dormant rules remain saved. Alternate models must be passed explicitly through the Agent tool.
_Avoid_: Model assignment, model override, model preference

**Pi availability**:
The models returned by `modelRegistry.getAvailable()` for the current Pi process. This is the authorization and normal-selection boundary. Provider origin is irrelevant: built-in and third-party providers are equally available when Pi reports their models here.
_Avoid_: Model catalogue, installed providers

**Model catalogue**:
The full `modelRegistry.getAll()` snapshot. It may contain built-in models without usable credentials and is used only for exact lookup and reliable destructive-cleanup checks, never as the ordinary Provider picker or alternate-authorization source.
_Avoid_: Available models, authorized models

**Dormant provider rule**:
A saved Agent/provider access rule whose provider is absent from Pi availability, or whose Provider access switch is disabled while it is not the current parent provider. Either condition preserves every rule; effective access returns only when every runtime gate passes again.
_Avoid_: Stale assignment, deleted provider

**Unavailable model rule**:
A saved exact model ID absent from a reliable current Model catalogue snapshot while that catalogue still contains the provider. It may be batch-removed by Clean unavailable rules. Authentication loss, provider unavailability, and model scope never create this state.
_Avoid_: Out-of-scope model, dormant provider rule

**Model scope**:
The active allowlist of models from pi (`--models`, `enabledModels`, or `/scoped-models`). A routed model must be inside this scope. Empty/unset scope means unrestricted. Scope affects effective access but never makes a saved rule eligible for stale-rule cleanup.
_Avoid_: Enabled models list, model filter

**Quick model setup**:
The short UI path for granting one agent type alternate access to models from the current parent provider. Checkbox changes persist immediately; adding access enables routing and the concrete provider through the same canonical `enabledProviders` and `agentAccess` state as the full menus. No Apply step or separate quick-settings schema exists.
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
- An alternate model must satisfy routing, Agent/provider, Agent/model, **Pi availability**, explicit-model, and **Model scope** checks; only the current parent provider bypasses the global Provider access switch
- **Quick model setup** writes the same rules as the full model-access menus
- A disabled or Pi-unavailable provider leaves **Dormant provider rules** intact
- **Provider access** contains only current available alternate-provider switches; Agent Provider pickers further intersect that inventory with enabled switches plus the current parent provider
- Agent model pickers show only Pi-available models inside the active **Model scope**, exclude the exact **Parent default**, and persist checkbox changes immediately
- Scope-excluded exact rules remain dormant and hidden; changing visible checkboxes must preserve them
- An **Unavailable model rule** can be batch-cleaned only from a reliable **Model catalogue**; credential loss and out-of-scope rules cannot
- Accepted running and queued work uses an **Invocation snapshot**
- **Agent guidance** communicates current effective access to the parent LLM before each run
- A **Subagent** may run in a **Worktree** of the parent's repository
- A **Nudge** is emitted when a background agent completes or errors
- **Grace turns** are added to the max-turn limit before a steered agent is hard-aborted

## Product boundaries

- The `Agent` tool is the only spawn entry point. `/agents` owns settings and diagnostics, not a second user-driven spawn flow. Revisit only if users need to start agents without involving the parent LLM.
- Model routing is authorization, not provider installation and not automatic model selection. Omitted `model` always means the exact parent model; rejected explicit choices never fall back silently. Alternate access and guidance use **Pi availability**, not the full **Model catalogue**.
- Provider disablement and authentication loss are reversible. Provider access shows only available alternate switches and has no Provider maintenance page; saved unavailable providers are managed separately without availability/effective diagnostics. Destructive cleanup is limited to explicit Clean unavailable rules, Delete saved access rules, and Clear routing settings actions.
- Configuration changes apply immediately to future Agent calls. Running and queued calls retain their invocation snapshot; users stop accepted work explicitly through StopAgent.
- The list and footer status stay hidden while no subagent records exist. The list defaults to expanded for each extension runtime, and `Alt+A` gives the user sole control over folding thereafter; transient zero records, pinning, and lifecycle changes do not alter that choice. While expanded, Main is a sticky row followed by at most six subagents and shows explicit running, queued, and total counts, including zero running or queued values. The footer is the folded summary and toggle handle, uses `Subagent`/`Subagents` according to total count, and never changes visibility. The list label and footer count share the same orange needs-input emphasis. Footer reading order is needs input, running/queued/total counts, `Alt+A`, then active-child `Alt+M`; Pi may discard trailing shortcut help first on narrow screens. Child-interaction failures replace Main's summary with a local `Blocked:` reason; they do not notify in Main's transcript area.
- Consumed terminal subagents are normally removed after 10 minutes. Space toggles independent session-local pins on highlighted subagents; pins pause automatic cleanup, do not change status ordering, and never block explicit Ctrl+D removal. Unpinning resumes the prior remaining duration rather than granting a fresh window.
- A failed subagent with a settled in-memory session remains available for the existing list-driven user interaction flow for 30 minutes, or until manual clear or parent shutdown. Active-view and pin pauses compose independently, and the recovery countdown resumes only after both are released; this prevents an expiry-triggered screen swap while the user is inspecting or retaining the session. This is not persisted resume, and the parent LLM does not receive a continuation tool.
- Debug may arm a session-local, one-shot fault for the next Agent that actually starts. Queued records do not reserve or consume it. Injected records show a separate accent-colored `[DEBUG]` provenance badge before the lifecycle status in the list and child header; Debug is not nested into the status label. Injection happens after the real child session is configured and before its first provider prompt, with a fixed 10-second recovery window; ordinary recoverable failures keep 30 minutes. Debug is UI-only, is not persisted across reload, does not create a provider probe or second spawn path, and exposes neither diagnostics nor lifecycle control to the parent LLM.
- Recoverable-failure presentation is local-only. External transports such as webhooks, Telegram, and email are deferred until a concrete consumer exists; future notifications must not include prompts, transcripts, source code, or findings by default.
- Concurrency is hierarchical rather than precedence-based: every run must satisfy an explicit Model ceiling or the fallback per-model ceiling, plus any shared Provider ceiling. New runs queue when either is full; settled-session continuation stays synchronous and reports one local concurrency block. Normal menus show only actionable/current-session limits, while inactive limits remain saved behind an explicit management row.
- Input usage accumulates provider-reported values without a vLLM-specific delta heuristic. Revisit only when a supported backend demonstrably reports cumulative prompt tokens without usable cache accounting.

## Tests

- `bun run test` runs the complete suite; GitHub Actions executes it on Ubuntu.
