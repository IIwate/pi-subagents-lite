# pi-subagents-lite

A lightweight pi extension that lets the LLM spawn autonomous child agents for complex tasks without scheduling or join modes.

## Language

### Core concepts

**Subagent**:
An autonomous child agent spawned from the parent conversation via the Agent tool.
_Avoid_: Child agent, worker, task agent

**Agent type**:
A named configuration (general-purpose, Explore, or custom) defining a subagent's tools, skills, system prompt, and runtime limits. Model-specific thinking behavior belongs to Parent default semantics or Thinking access rules rather than the Agent type itself.
_Avoid_: Agent kind, agent class

**Agent guidance**:
A compact deterministic system-prompt block added automatically with `before_agent_start`. It distinguishes currently callable and unavailable agent types, teaches the parent LLM each agent type's effective Parent default access, marks `model` as required when no Parent default exists, and lists every effective alternate as an exact canonical model key. It never substitutes wildcard policy summaries for callable arguments, is not a session message, and requires no manual refresh.
_Avoid_: Agent briefing, agent documentation, tool description

**Subagent system prompt**:
The exact system prompt provided to a Subagent when its isolated session is created, composed from its accepted Agent type definition, system prompt mode, skills, context files, and runtime environment. It is distinct from Agent guidance, which is added to the parent LLM. An unavailable inherit source fails the run and does not switch mode; a missing custom prompt file may still replace the header and notify.
_Avoid_: Child prompt, injected prompt, Agent guidance

**Stealth tool**:
A tool registered at extension initialization with no description, promptSnippet, or promptGuidelines. The stable tool set preserves prompt-cache behavior; current usage and access rules come from dynamic Agent guidance.
_Avoid_: Hidden tool, minimal tool

### Configuration

**Model access**:
The configuration area governing Parent model access, alternate model authorization, and Thinking access rules for agent types. A fresh installation is Parent-only; users explicitly authorize alternate Providers and models when they know which model they want. Configured via `/agents` > Model access.
_Avoid_: Model assignment, model settings

**Model routing**:
The policy switch controlling access to models other than the exact parent model. OFF is the fresh-install default and disables alternates while Parent default availability remains governed separately by each agent type's Parent model access. ON applies Provider access and per-agent Model access rules.
_Avoid_: Cross-provider routing, model assignment

**Provider access**:
The explicit mutable allowlist for Pi-available alternate providers. Providers not selected by the user remain unavailable to every agent type; becoming the current parent provider never restores its alternate models. The exact Parent default remains governed independently by Parent model access.
_Avoid_: Installed providers, Provider maintenance

**Saved unavailable provider**:
A provider referenced by saved alternate-access state but absent from current Pi availability. Current parent-provider status does not exclude it because alternate access remains subject to explicit Provider access; exact Parent default access remains independent. It is managed only through the conditional exception flow.
_Avoid_: Unavailable Provider access switch, Provider diagnostic

**Parent default**:
The exact model active in the parent session when the Agent call is accepted. It is a dynamic candidate rather than a persisted model assignment, and an agent type may use it only when granted Parent model access.
_Avoid_: Global default, inherited assignment, parent fallback

**Parent model access**:
A per-agent-type authorization controlling every use of the dynamic Parent default. It is granted when no explicit setting exists for backward compatibility; when explicitly denied, both omission of `model` and explicit selection of the exact parent model are rejected, and ordinary alternate Model access rules cannot restore it. The user-facing control is labeled **Use parent model**.
_Avoid_: Parent access, Parent inheritance switch, parent fallback, global parent access

**Model access rule**:
A persistent authorization for one agent type to use one explicitly enabled Provider. All models authorizes every Pi-available, in-scope model from that Provider, including future models. Removing the first current model switches to a Selected models snapshot before that model is removed; reselecting every current model remains Selected until the user explicitly restores All models. A Provider rule is absent until the user explicitly creates it. Alternate models must be passed explicitly through the Agent tool.
_Avoid_: Model assignment, model override, model preference

**Thinking access rule**:
The effective policy for one agent type and exact model, containing a non-empty set of allowed Pi thinking levels and one default level from that set. Without a saved override, every model-supported level is allowed: Parent default inherits the parent session's current thinking, while an alternate defaults to Pi's model-supported normalization of `high`. The first restriction or default change creates an explicit override; later re-allowing every current level keeps that override and its default until Reset baseline explicitly restores dynamic behavior. An explicit thinking choice outside the effective allowed set is rejected rather than clamped or replaced. A saved policy with no currently valid allowed/default combination suspends that model for the agent type without rewriting the policy.
_Avoid_: Thinking capability, max thinking, fixed thinking

**Pi availability**:
The models returned by `modelRegistry.getAvailable()` for the current Pi process. This is the authorization and normal-selection boundary. Provider origin is irrelevant: built-in and third-party providers are equally available when Pi reports their models here.
_Avoid_: Model catalogue, installed providers

**Model catalogue**:
The full `modelRegistry.getAll()` snapshot. It may contain built-in models without usable credentials and is used only for exact lookup and reliable destructive-cleanup checks, never as the ordinary Provider picker or alternate-authorization source.
_Avoid_: Available models, authorized models

**Dormant provider rule**:
A saved Agent/provider access rule whose provider is absent from Pi availability or whose Provider access switch is disabled. Current parent-provider status bypasses neither condition; exact Parent default access remains independent. Either condition preserves every rule; effective access returns only when every runtime gate passes again.
_Avoid_: Stale assignment, deleted provider

**Unavailable model rule**:
A saved exact model ID absent from a reliable current Model catalogue snapshot while that catalogue still contains the provider. It may be batch-removed by Clean unavailable rules. Authentication loss, provider unavailability, and model scope never create this state.
_Avoid_: Out-of-scope model, dormant provider rule

**Model scope**:
The active allowlist of models from pi (`--models`, `enabledModels`, or `/scoped-models`). A routed model must be inside this scope, and a scope-pinned thinking level becomes that model's only effective allowed and default level for every agent type, including Parent default use. Empty/unset scope means unrestricted. Scope affects effective access but never rewrites saved rules or makes them eligible for stale-rule cleanup.
_Avoid_: Enabled models list, model filter

**Quick model setup**:
The short UI path for explicitly authorizing one agent type to use alternate models from the current parent Provider. It remains available while Model routing is OFF; selecting models atomically enables Model routing, enables that concrete Provider, and writes the same canonical Agent/Provider/Model access state as the full menus. Any failed selection leaves no partial configuration.
_Avoid_: Quick assignment, quick default

**Grace turns**:
Additional turns allowed after the soft turn limit steer message before hard abort. Default 6, configurable via `/agents` > Spawn options.
_Avoid_: Grace period, extra turns

### Worktrees

**Worktree**:
The parent repository's main checkout or one of its linked git worktrees, identified by sharing the same resolved `--git-common-dir`. A valid target of the `worktree_path` Agent tool param.
_Avoid_: Arbitrary checkout, sibling repository

**Worktree path**:
The resolved absolute filesystem path passed through `worktree_path`. It must identify a Worktree of the parent's repository and becomes the subagent's working directory for its session, resource loader, and system prompt.

### Runtime

**Accepted run policy**:
The deep-copied Agent definition, resolved tool/skill/extension loading policy, system prompt mode, context-file setting, model, parent model, thinking selection, scoped-model state, output-token limit, and grace turns locked after an Agent call passes authorization. Running and queued agents use this snapshot; later registry, configuration, parent-model, or scope changes affect only future calls. `inherit` captures its mode while Pi supplies the parent prompt text at actual start time; an unavailable inherit source fails the run and does not switch mode. A missing custom prompt file may still replace the header and notify.
_Avoid_: Queue revalidation, live assignment

**Child screen**:
The selected Subagent transcript and input route displayed in place of Main's chat region. Pi 0.84 regular and fullscreen renderers reuse the same document and dock components, so runtime mode switching keeps the Child screen active. Main's pending and status regions are suppressed by temporarily replacing their render methods, while the footer container remains owned by Pi and other extensions.
_Avoid_: Child TUI, replacement session, alternate Main

**Background result delivery**:
A terminal background result is persisted with the parent session ID and Agent-call origin entry before one automatic wake opportunity. Concurrent wake requests are coalesced. A completion persisted during a failed parent turn provides one later wake opportunity after settlement; the failed delivery alone never retries itself. A later persisted completion can carry older eligible pending results. Delivery is allowed only while the origin entry remains on the active branch. Explicit session reload or `/tree` navigation back to that origin is a separate restoration event. The next natural parent prompt injects eligible pending results during preflight, including after a failed automatic wake. Exact AgentStatus reads join the current parent turn's successful-settlement acknowledgement.
_Avoid_: Session-global injection, 200ms debounce, logical task batch, join mode

## Relationships

- **Model access** contains **Parent model access**, **Model routing**, **Model access rules**, and **Thinking access rules**
- An **Agent type** may have multiple **Model access rules** across multiple providers
- Every authorized Agent type and exact model has an effective **Thinking access rule**; a saved override follows the exact model across Parent default and alternate roles
- Without a saved override, the **Parent default** allows every model-supported thinking level and inherits the parent session's current thinking when omitted
- Without a saved override, a non-parent model allows every model-supported thinking level and defaults to Pi's model-supported normalization of `high`; global and Agent-type thinking defaults do not exist
- A **Model scope** thinking pin replaces the effective allowed/default thinking policy with that one mandatory level without changing persisted policy
- A **Subagent** is spawned from one **Agent type**
- An **Agent type** may grant or deny **Parent model access** to the dynamic **Parent default**; denial blocks both implicit and explicit selection, including a saved alternate that currently becomes the exact parent model
- An alternate model must satisfy Model routing, explicit global Provider access, the Agent type's Provider/Model access rule, **Pi availability**, explicit-model selection, and **Model scope**; the current parent provider never bypasses an explicit Provider restriction
- **Quick model setup** writes the same rules as the full model-access menus
- A disabled or Pi-unavailable provider leaves **Dormant provider rules** intact
- **Provider access** and per-agent **Model access rules** are explicit allowlists; Pi availability and Model scope are necessary but never sufficient to grant an alternate, including alternates from the current parent Provider
- Agent model rules may authorize All models from an enabled Provider or a non-empty Selected models set; the exact **Parent default** remains governed separately
- Scope-excluded exact rules remain dormant and hidden; changing visible checkboxes must preserve them
- An **Unavailable model rule** can be batch-cleaned only from a reliable **Model catalogue**; credential loss and out-of-scope rules cannot
- Accepted running and queued work uses an **Accepted run policy**; later parent-model changes affect only future Agent calls
- Selecting a **Subagent** activates its **Child screen** without changing that Subagent's lifecycle
- **Agent guidance** communicates current effective access to the parent LLM before each run
- A **Subagent** may run in a **Worktree** of the parent's repository
- A **Background result delivery** entry is persisted when a background agent completes or errors, and is automatically eligible only inside its origin-entry subtree
- **Grace turns** are added to the max-turn limit before a steered agent is hard-aborted

## Product boundaries

- The `Agent` tool is the only spawn entry point. `/agents` owns settings and diagnostics, not a second user-driven spawn flow. Revisit only if users need to start agents without involving the parent LLM.
- Model routing is authorization, not provider installation and not automatic model selection. A fresh installation is Parent-only; the exact parent model is usable only through the chosen Agent type's **Parent model access**. Every alternate requires explicit Provider and Agent/model authorization, and rejected or missing choices never fall back silently. Alternate access and guidance use **Pi availability**, not the full **Model catalogue**.
- Provider and Model access are opt-in. All models is available only inside an explicitly created Agent/provider rule; thinking remains all model-supported levels until the user saves an exact Agent/model override. Switching All models to Selected snapshots the current visible models, and only an explicit All models action restores future-model inclusion. Provider disablement and authentication loss remain reversible and never trigger destructive cleanup.
- Reset Model access restores the complete fresh-install policy: Parent model access defaults ON, Model routing is OFF, Provider and Agent/model rules are empty, and thinking overrides are absent.
- Configuration changes apply immediately to future Agent calls. Disabling built-in Agent types immediately blocks new calls and on-demand discovery while preserving same-name custom definitions; running and queued calls retain their complete accepted run policy, and users stop accepted work explicitly through StopAgent.
- Foreground Agent calls are bound to Pi's parent tool-call interrupt signal. Interrupting a parent turn stops its running foreground Agents and removes its queued foreground Agents from execution while retaining `Stopped` records; background Agents remain detached. List-focused `Esc` keeps its navigation meaning and only returns focus to the editor.
- The list and folded Footer stay hidden while no subagent records or active delivery state exist. Normal in-flight automatic delivery adds no pending UI text; a blocked or failed delivery shows nonzero `results pending`. This state can keep sticky Main visible after a volatile Agent record is cleaned; results from unrelated branches remain hidden. The persisted Display setting defaults new conversations to an expanded list, while `Alt+A` gives the user sole control over folding for the current runtime thereafter; changing the default does not override the current choice, and the menu tells the user that `/reload` recreates the runtime and applies the new default immediately. Transient zero records, pinning, and lifecycle changes do not alter the current choice. While expanded, sticky Main owns explicit running/queued/total counts, `Alt+A collapse`, and active-child `Alt+M main`, followed by at most six subagents; this extension emits no Footer status. While folded, the Footer becomes the compact replacement, uses `Subagent`/`Subagents`, and shows the same summary with `Alt+A expand`. Child-interaction failures replace the expanded Main or folded Footer summary with a local `Blocked:` reason; they do not notify in Main's transcript area.
- Persisted terminal subagents are normally removed from the volatile list after 10 minutes; their parent-session result entries remain available for origin-subtree delivery and explicit session-wide AgentStatus lookup. An explicit result read is acknowledged only after its parent turn settles successfully. New/forked sessions ignore copied entries whose parent session ID does not match. Append failures are held in process-local buckets keyed by parent session ID; reading, replacing, or clearing one bucket never affects another. Space toggles independent session-local pins on highlighted subagents; pins pause automatic cleanup, do not change status ordering, and never block explicit Ctrl+D removal. Unpinning resumes the prior remaining duration rather than granting a fresh window.
- A failed subagent is an ordinary `Error` terminal result and is immediately sent through persistence and parent delivery. If its settled child session remains in memory, the selected child view may send another prompt during the ordinary 10-minute retention period. The continuation creates a new terminal result without retracting or duplicating the first. Pinning pauses ordinary cleanup; opening the child view does not. This is not persisted resume, and the parent LLM does not receive a continuation tool.
- Debug may arm a session-local, one-shot fault for the next Agent that actually starts. Queued records do not reserve or consume it. Injected records show a separate accent-colored `[DEBUG]` provenance badge before the ordinary status in the list and child header. Injection happens after the real child session is configured and before its first provider prompt. Debug is UI-only, is not persisted across reload, does not create a provider probe or second spawn path, and exposes neither diagnostics nor lifecycle control to the parent LLM.
- The **Child screen** supports Pi 0.84 regular and fullscreen renderers and remains selected across runtime mode switches. It replaces only the document chat child, temporarily renders pending/status containers empty, and wraps the footer-container render while preserving the component instances held by fullscreen's ScrollView and dock. Built-in Main cwd and model-usage footer rows are removed while extension status rows remain; custom footers and replacements made by other extensions are rendered intact. Returning to Main, disposal, or `/reload` restores only references still owned by this extension. An unknown root/document layout or a conflicting render replacement fails closed before any partial screen mutation.
- Error presentation is local-only. Parent-session result entries are the only durable handoff; external transports such as webhooks, Telegram, and email are deferred until a concrete consumer exists. Future notifications must not include prompts, transcripts, source code, or findings by default.
- Concurrency is hierarchical rather than precedence-based: every run must satisfy an explicit Model ceiling or the fallback per-model ceiling, plus any shared Provider ceiling. New runs queue when either is full; settled-session continuation stays synchronous and reports one local concurrency block. Normal menus show only actionable/current-session limits, while inactive limits remain saved behind an explicit management row.
- Input usage accumulates provider-reported values without a vLLM-specific delta heuristic. Revisit only when a supported backend demonstrably reports cumulative prompt tokens without usable cache accounting.

## Tests

- `bun run test` runs the complete suite; GitHub Actions executes it on Ubuntu.
