# @iiwate/pi-subagents-lite

Lightweight subagents for [pi](https://pi.dev), with isolated sessions, per-agent tools and models, background execution, and a keyboard-driven list below the editor. Agent tool calls and completion delivery stay out of the chat UI.

## Install

Requires Pi 0.84.1.

```bash
pi install npm:@iiwate/pi-subagents-lite
pi install -l npm:@iiwate/pi-subagents-lite   # project-local
pi -e npm:@iiwate/pi-subagents-lite           # try for one run
```

## Usage

The extension registers three tools for the LLM:

- `Agent` — start a subagent. Foreground runs wait for completion; `run_in_background: true` returns immediately.
- `StopAgent` — stop a running or queued agent by ID.
- `AgentStatus` — list agents, or read one exact result by `agent_id` without polling or waiting.

Once a subagent exists, progress appears in the below-editor list or its folded Footer summary. The list has a sticky Main row and up to six visible subagents scrolled around the focused row. It starts expanded by default; `/agents` → Display settings → Expand list by default persists a different initial choice for new conversations. After changing it, the menu reports that `/reload` applies the new default immediately by recreating the current conversation's extension runtime. `Alt+A` toggles only the current runtime, and that choice remains even if the volatile record count temporarily reaches zero. With no records and no pending results eligible for the active branch, both the list and footer status stay hidden. Status follows the agent name in parentheses; provider, model, and thinking appear before usage stats. Agent rows use status-rank order: attention (Error, Aborted, Turn limit), then Running, then Queued, then archived Done and Stopped. Same-rank rows keep acceptance order:

```text
› ● Main (1 running · 3 total · Alt+A collapse)
  ○ Security (Error)  Audit authentication             anthropic · claude-sonnet-4 · high · 81 calls · 36m
  ○ Explore (Running)  Inspect the project              openai-codex · gpt-5.4 · high · 4 calls · 25s
  ◇ Reviewer (Done)  Preserve this review               openai-codex · gpt-5.4 · high · 12 calls · 2m
```

- `›` marks the keyboard-highlighted row.
- `○` and `●` mark inactive and active unpinned transcripts.
- `◇` and `◆` mark inactive and active session-local pinned transcripts.
- Main shows nonzero `running` and `queued` counts plus the total list count. A blocked child interaction temporarily replaces those counts with a local `Blocked: ...` reason; while the list is folded, the Footer shows that reason instead. Neither path notifies in Main's transcript area.
- While expanded, sticky Main owns the running/queued/total counts, exceptional `results pending` state for the active branch, `Alt+A collapse`, and active-child `Alt+M main`; this extension adds no Footer status in the normal path. Normal in-flight automatic delivery does not show pending text. While folded, the Footer becomes the compact replacement and uses `Subagent` or `Subagents` according to retained count. Zero pending results are hidden. Both forms show counts, delivery state when nonzero, `Alt+A`, then active-child `Alt+M`; narrow screens may truncate trailing help first.
- Status values are `Queued`, `Running`, `Done`, `Stopped`, `Turn limit`, `Aborted`, and `Error`.
- With an expanded list and empty editor, press `↓` to focus it. Use `↑`/`↓` to move, `Enter` to activate, `Space` to pin or unpin, and `Esc` to return to the editor.
- Pins pause automatic cleanup without changing status ordering. Multiple Agents may be pinned; unpinning resumes the remaining cleanup time rather than granting a fresh window.
- Press `Ctrl+D` on an inactive subagent to clear it, including a pinned one; `Enter` confirms and `Esc` cancels. Running agents are stopped first.
- Foreground Agent calls honor Pi's interrupt signal: `Esc` from the editor stops every running or queued foreground Agent in the interrupted parent turn, while background Agents continue. If the list has focus, `Esc` only returns to the editor; press it again there to interrupt.
- While a subagent is active, editor input is routed to that session. Press `Alt+M` to return to Main from either an expanded or folded list; this changes only the active transcript and input route, not list visibility or child execution. Switching Pi between regular and fullscreen TUI modes preserves the selected child, transcript, and input route because both renderers reuse the same component tree. The built-in Main cwd and model-usage footer rows are hidden on the child screen, leaving extension statuses; a custom footer supplied by another extension is preserved, including replacements made while the child is active. If Pi exposes an unsupported host layout, child activation fails closed with one warning instead of partially replacing Main.
- Persisted terminal results are normally removed from the volatile Agent list after 10 minutes; the parent session result entry remains available for later delivery and exact lookup. Automatic delivery is limited to branches that retain the Agent call's origin entry; explicit `AgentStatus({ agent_id })` lookup remains session-wide. An `Error` record with a retained live session can accept another prompt through the selected child view during the same ordinary retention period. That interaction produces a new terminal result and never retracts or duplicates the first delivery. Pinning extends ordinary retention; viewing does not. Child sessions and pins are not persisted across `/reload` or process exit, and the parent LLM has no continuation tool.

Each new subagent starts without the parent's conversation history. Background terminal results, including errors, are immediately persisted in the parent Pi session with the Agent call's session ID and origin entry before one automatic wake opportunity. Each injected wake body is clipped to 4000 characters; the persisted record and `AgentStatus({ agent_id })` still carry the full text. They are delivered only while that origin remains on the active branch. A completion persisted during a failed parent turn provides one later wake opportunity after settlement; the failed result alone does not retry itself. A later persisted completion may carry older eligible pending results, while the next natural parent prompt injects them during preflight even after an automatic wake failed. Explicit reload or `/tree` return to the origin is a separate restoration event; forked or new sessions ignore copied entries from the old session. Do not poll, sleep, or repeatedly call `AgentStatus` while waiting. Use `AgentStatus({ agent_id })` only for explicit session-wide result lookup; that read is acknowledged only after its parent turn settles successfully.

## Built-in Agents

- `general-purpose` — general task execution using the configured session tools.
- `Explore` — read-only codebase exploration.

Built-ins can be overridden by custom agents or disabled from `/agents`. Disabling them takes effect immediately for future `Agent` calls and on-demand discovery; running and queued agents continue with the complete policy captured when accepted, and same-name custom definitions remain available.

## Custom Agents

Agent definitions are Markdown files loaded from:

- `~/.pi/agent/agents/*.md` — user-wide agents.
- `.pi/agents/*.md` — project agents.

Project definitions override user definitions, which override built-ins with the same name. Overrides are merged field by field.

```markdown
---
name: reviewer
display_name: Reviewer
description: Review code without modifying it
tools:
  - read
  - grep
  - find
max_turns: 12
extensions: false
skills:
  - review-guidelines
---

Review the requested changes. Prioritize correctness, regressions, and missing tests.
```

Supported frontmatter fields:

- Identity: `name`, `display_name`, `description`, `hidden`.
- Capability: `tools`, `exclude_tools`, `extensions`, `exclude_extensions`, `skills`, `preload_skills`.
- Runtime: `max_turns`, `max_tokens`.

A `thinking` frontmatter field is retired and ignored with a warning; thinking is selected per call and governed by Thinking policies under Model access.

Frontmatter supports flat values and lists, not nested YAML objects. Extension tools may be selected with `extension/tool` or `extension/*`. A positive `max_tokens` is applied to a child-only copy of the selected model through Pi's native `model.maxTokens`; Pi remains responsible for provider-specific request fields, thinking budgets, and context-window clamping. Omitting `max_tokens` or setting it to a non-positive value preserves the model's configured limit, and the parent model and Pi's `onPayload` chain are not modified. Subagents cannot spawn further subagents.

## Agent Options

`Agent` accepts:

- `prompt` — required task text.
- `description` — short list label; defaults to the first prompt line.
- `agent` — agent type; defaults to `general-purpose`.
- `model` — an exact canonical `provider/model` key for an authorized alternate. Bare model IDs and `:thinking` suffixes are not accepted. Omit it to use the parent model.
- `thinking` — one of Pi's canonical levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. The value must be inside the effective Thinking policy for the selected Agent type and exact model; a disallowed value is rejected with the allowed levels, never silently clamped.
- `run_in_background` — return immediately and notify the parent when complete.
- `worktree_path` — the parent repository's main checkout or a linked worktree from the same repository. Its `.pi/agents/` directory is scanned for that spawn.

Unknown agent type, unauthorized model or Thinking, and invalid `worktree_path` fail as tool errors before the run is spawned. After spawn, a foreground snapshot error is still a completed-run result.

## Model access

By default, every subagent requests the exact model active in the parent session when the Agent call is accepted. Omitting `model`, or explicitly passing that same model key, selects this **Parent default**. The selected Agent type must have **Parent model access**; that access is an explicit policy and is not bypassed by omitting `model`. When it is denied, omitting `model` fails directly — no alternate is chosen automatically.

With **Alternate models** OFF (`/agents` > Model access), any other model is rejected. With it ON, an alternate model is authorized only when all of these are true:

- its Provider is explicitly enabled for routing, including when it is the current parent Provider;
- the selected agent type has access to that provider;
- the agent's provider rule allows all models or the exact model ID;
- Pi reports the exact model through `modelRegistry.getAvailable()`;
- the model is inside Pi's active model scope.

The current parent Provider never bypasses an explicit Provider restriction. Same-provider alternates still need an explicit Agent tool `model` argument, Alternate models ON, a saved Agent/provider/model rule, Pi availability, and active scope. A rejected explicit choice is never replaced silently with the Parent model. The exact Parent model remains subject to the Agent type's Parent model access.

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
          "google": { "models": ["gemini-2.5-pro", "gemini-2.5-flash"] }
        }
      }
    }
  }
}
```

An omitted `models` property means all models that Pi currently or later reports available from that provider. It does not authorize unauthenticated entries from Pi's full built-in catalogue. A non-empty array means only those exact IDs. Empty arrays are removed and never interpreted as all-model access.

Each Agent access page begins with the Parent model access toggle, showing the current parent key and its effective default thinking, followed by that agent's Provider rules and its Thinking policies entry:

```text
[x] Use parent model · openai/gpt-5 · high
openai
anthropic
Thinking policies
```

**Quick model setup** grants one agent alternate access to models from the current parent provider in one short flow. Its model checkboxes save immediately, enabling Alternate models and the concrete provider when access is added. It writes the same `enabledProviders` and `agentAccess` state as the full menus; there is no Apply row or separate quick configuration.

**Provider access** is a direct switch list built fresh from `modelRegistry.getAvailable()`. It starts with a non-actionable Parent default row, then every currently available provider — including the current parent provider — as an ordinary toggle; there are no availability diagnostics or Provider detail pages. The top-level summary counts providers that are both enabled and currently available.

Saved routing state for providers absent from Pi availability is shown separately as **Saved unavailable providers**. That exception flow can toggle dormant routing state or explicitly delete every saved Agent rule after multiline confirmation. Toggling never deletes rules, and zero rule counts are omitted.

After selecting an Agent, its page shows providers that are enabled for routing and currently available. Disabled or unavailable providers are hidden while their rules remain dormant.

The Agent model picker shows only actionable alternates: Provider models from `getAvailable()` intersected with Pi's active model scope, excluding the exact parent model. `All models` and exact-model checkboxes save immediately; there is no Apply row or normal-state status text. Scope-excluded and unavailable models stay hidden, while saved exact IDs remain dormant in configuration and reappear if their prerequisite returns.

**Thinking policies** are saved per Agent type and exact model, and follow that model whether it is currently the Parent default or an alternate. Without a saved override, a Parent default allows every model-supported level and inherits the parent session's current thinking, while an alternate defaults to `high` clamped to the model's capability. The policy page toggles allowed levels per model, cycles the default among allowed levels, and can reset to the dynamic baseline; the final allowed level cannot be removed. A Pi Model scope thinking pin overrides the saved policy with that one mandatory level. **Reset Model access** restores the fresh-install state: Alternate models OFF, no Provider or Agent rules, no Parent access or Thinking overrides.

**Clean unavailable rules** appears only when a reliable fresh `modelRegistry.getAll()` catalogue proves that saved exact model IDs are missing while their provider remains in the catalogue. Its global multiline confirmation lists every affected Provider, Agent, and model ID, then re-reads the catalogue and removes only IDs still unavailable. Credential or `getAvailable()` loss, scope changes, all-model rules, and an absent/unreliable catalogue provider never create cleanup candidates. Persisted dormant exact IDs remain intact until an explicit rule change or cleanup action.

Current Agent types, Parent default, and effective model access are added automatically to the parent system prompt with Pi's `before_agent_start` hook. Every callable alternate is listed as an exact `provider/model` key with its allowed and default thinking levels, including models allowed by an `All models` rule; wildcard policy summaries are never used as Agent arguments. Agent types with no callable model are listed as unavailable, and guidance states when a `model` argument is required because Parent access is denied. Alternate authorization and guidance use the current `getAvailable()` keys; catalogue-only models are never advertised or callable. Configuration, parent-model, availability, and scope changes are reflected on the next parent run without `/reload`, a manual briefing, a session message, or an extra LLM turn.

The selected Agent definition, tool policy, skill and extension loading policy, system prompt mode, context-file setting, model, parent model, thinking selection, scoped-model state, output-token limit, and grace turns are locked when the Agent call is accepted. Arrays and nested policy data are copied. Running and queued agents retain that accepted policy; later settings or registry changes affect only future Agent calls. In `inherit` mode, the mode is captured but Pi supplies the parent system prompt text when the queued run starts. An unavailable inherit source fails the run and does not switch mode. A missing custom prompt file may still replace the header and notify, because settings can show and create that file.

## Concurrency

The fallback ceiling is 4 concurrent runs per model. An explicit Model limit replaces that per-model fallback, while a Provider limit is an independent shared hard ceiling across every model from that Provider. A run starts only when both ceilings have room; Model limits may sum above the Provider limit so idle capacity remains shareable.

New Agent calls beyond either ceiling enter `Queued`. Continuing a settled child does not queue: the input remains in the editor and Main shows `Blocked: provider/model concurrency limit reached` until a later successful send or Agent switch.

The Concurrency menu shows the parent model, currently authorized alternates, and models retained by existing child sessions. Limits outside that actionable inventory stay saved and appear as **Inactive Provider ·** / **Inactive Model ·** rows, reappear as ordinary Provider/Model rows when their prerequisite returns, and are removed only through an explicit user action.

## Settings

Run `/agents` to configure:

- Parent model access and inheritance, Quick model setup, Provider access switches, unavailable-provider exceptions, and per-agent provider/model access;
- the fallback per-model ceiling, shared Provider ceilings, per-model ceilings, and Inactive Provider / Inactive Model rows;
- force-background mode, grace turns, and exact Agent/model Thinking access overrides;
- system prompt mode (`replace`, `inherit`, or `custom`) and `AGENTS.md` inclusion;
- implicit skill and extension loading, built-in agents, initial list expansion, and visible list statistics. `/agents` → Display settings → Show context % controls the list `%` and compaction `↻`;
- agent type inspection, runtime diagnostics, and UI-only status previews for list-layout testing;
- one-shot fault injection after the next real child session is configured. Injected records show a separate accent-colored `[DEBUG]` badge before their ordinary terminal status in both the list and child header. Controls and runtime diagnostics are session-local and UI-only. The parent LLM can observe the normal Agent call failing, but cannot arm faults, inspect Debug diagnostics, or continue the child through an extra tool.

Settings are stored in `~/.pi/agent/subagents-lite.json`. Custom prompt mode uses `~/.pi/agent/subagents-lite-prompt.md`.

## License

MIT — see [LICENSE](./LICENSE).
