# @iiwate/pi-subagents-lite

Lightweight subagents for [pi](https://pi.dev), with isolated sessions, per-agent tools and models, background execution, and a keyboard-driven list below the editor. Agent tool calls and completion delivery stay out of the chat UI.

## Install

Requires Pi 0.83.x.

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

Once a subagent exists, progress appears in the below-editor list with a sticky Main row and up to six visible subagents scrolled around the focused row. The list starts expanded; `Alt+A` toggles it, and that choice remains for the current extension runtime even if the volatile record count temporarily reaches zero. With no records and no pending results eligible for the active branch, both the list and footer status stay hidden. Status follows the agent name in parentheses; provider, model, and thinking appear before usage stats. `Needs input` agents sort first and `Done` agents last:

```text
› ● Main (1 needs input · 1 running · 0 queued · 3 total · Alt+A collapse)
  ○ Security (Needs input)  Audit authentication       anthropic · claude-sonnet-4 · high · 81 calls · 36m
  ○ Explore (Running)  Inspect the project              openai-codex · gpt-5.4 · high · 4 calls · 25s
  ◇ Reviewer (Done)  Preserve this review               openai-codex · gpt-5.4 · high · 12 calls · 2m
```

- `›` marks the keyboard-highlighted row.
- `○` and `●` mark inactive and active unpinned transcripts.
- `◇` and `◆` mark inactive and active session-local pinned transcripts.
- Main always shows complete `running`, `queued`, and total list counts, including zero values. A blocked child interaction temporarily replaces those counts with a local `Blocked: ...` reason; while the list is folded, the Footer shows that reason instead. Neither path notifies in Main's transcript area.
- While expanded, sticky Main owns the needs-input count, running/queued/total counts, exceptional `results pending` or intentional `results waiting for next turn` state for the active branch, `Alt+A collapse`, and active-child `Alt+M main`; this extension adds no Footer status in the normal path. Normal in-flight Auto delivery does not show pending text. While folded, the Footer becomes the compact replacement and uses `Subagent` or `Subagents` according to retained count. Zero pending results are hidden. Both forms follow reading order: needs input, counts, delivery state when nonzero, `Alt+A`, then active-child `Alt+M`; narrow screens may truncate trailing help first.
- Status values include `Queued`, `Running`, `Done`, `Stopped`, `Turn limit`, `Aborted`, `Error`, and `Needs input`. The list label, expanded Main count, and folded Footer count use the same orange emphasis without changing list visibility.
- With an expanded list and empty editor, press `↓` to focus it. Use `↑`/`↓` to move, `Enter` to activate, `Space` to pin or unpin, and `Esc` to return to the editor.
- Pins pause automatic cleanup without changing status ordering. Multiple Agents may be pinned; unpinning resumes the remaining cleanup time rather than granting a fresh window.
- Press `Ctrl+D` on an inactive subagent to clear it, including a pinned one; `Enter` confirms and `Esc` cancels. Running agents are stopped first.
- Foreground Agent calls honor Pi's interrupt signal: `Esc` from the editor stops every running or queued foreground Agent in the interrupted parent turn, while background Agents continue. If the list has focus, `Esc` only returns to the editor; press it again there to interrupt.
- While a subagent is active, editor input is routed to that session. Press `Alt+M` to return to Main from either an expanded or folded list; this changes only the active transcript and input route, not list visibility or child execution. The built-in Main cwd and model-usage footer rows are hidden on the child screen, leaving extension statuses; a custom footer supplied by another extension is preserved.
- Persisted terminal results are normally removed from the volatile Agent list after 10 minutes; the parent session result entry remains the recovery source. Automatic delivery is limited to branches that retain the Agent call's origin entry; explicit `AgentStatus({ agent_id })` lookup remains session-wide. `Needs input` means the run failed after a live child session already existed and instead has a 30-minute recovery window. Select it and send another prompt to continue the same in-memory session. Viewing or pinning it pauses the remaining recovery time; the countdown resumes only after both pause reasons are released. Pins and child recovery state are not persisted across `/reload` or process exit, and the parent LLM has no continuation tool.

Each new subagent starts without the parent's conversation history. Background results are persisted in the parent Pi session with the Agent call's session ID and origin entry. They are delivered only while that origin remains on the active branch: `Auto continue` (default) wakes the parent when possible, while `Next natural turn` waits for the next ordinary parent prompt. An Auto result completed and persisted during a failed parent turn provides one later automatic wake opportunity; the failed result alone does not retry itself automatically, and Next-turn completions never trigger Auto delivery. Explicit reload or `/tree` return to the origin is a separate recovery event that re-arms eligible Auto results; forked or new sessions ignore copied entries from the old session. Do not poll, sleep, or repeatedly call `AgentStatus` while waiting. Use `AgentStatus({ agent_id })` only for explicit session-wide result recovery; that read is acknowledged only after its parent turn settles successfully.

## Built-in Agents

- `general-purpose` — general task execution using the configured session tools.
- `Explore` — read-only codebase exploration.

Built-ins can be overridden by custom agents or disabled from `/agents`.

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
thinking: high
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
- Runtime: `thinking`, `max_turns`, `max_tokens`.

Frontmatter supports flat values and lists, not nested YAML objects. Extension tools may be selected with `extension/tool` or `extension/*`. Subagents cannot spawn further subagents.

## Upgrading to 2.0

Version 2.0 replaces fixed Agent model assignments with the access policy below. Legacy `allowCrossProvider`, `allowedProviders`, `agentModels`, dynamic `agent.<type>` model keys, `agent.default`, and session assignments are not read or migrated. Agent frontmatter `model` is also ignored; omit the Agent tool's `model` argument for the exact parent model, or pass an explicitly authorized alternate.

A missing or legacy `modelRouting` block starts with routing OFF and no alternate access. Other Agent and concurrency settings continue to load. The next explicit settings save rewrites the file with only the canonical 2.0 routing schema.

## Agent Options

`Agent` accepts:

- `prompt` — required task text.
- `description` — short list label; defaults to the first prompt line.
- `agent` — agent type; defaults to `general-purpose`.
- `model` — `id`, `provider/id`, or either form with a `:thinking` suffix. The model must resolve exactly and remain inside Pi's active model scope.
- `thinking` — a non-empty provider thinking level; common values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
- `run_in_background` — return immediately and notify the parent when complete.
- `worktree_path` — the parent repository's main checkout or a linked worktree from the same repository. Its `.pi/agents/` directory is scanned for that spawn.

## Model Routing

By default, every subagent uses the exact model active in the parent session when the Agent call is accepted. Omitting `model`, or explicitly passing that same model key, selects this **Parent default**. It is always available and is never persisted as routing configuration.

With **Model routing** OFF (`/agents` > Model routing), any other model is rejected. With routing ON, an alternate model is authorized only when all of these are true:

- its provider is globally enabled for routing, unless it is the current parent provider;
- the selected agent type has access to that provider;
- the agent's provider rule allows all models or the exact model ID;
- Pi reports the exact model through `modelRegistry.getAvailable()`;
- the model is inside Pi's active model scope.

The current parent provider bypasses only the global provider switch while it remains the parent. Same-provider alternates still need an explicit Agent tool `model` argument, routing ON, a saved Agent/provider/model rule, Pi availability, and active scope. A rejected explicit choice is never replaced silently with the parent model. The exact parent model remains unconditional.

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

Each agent access page begins with a locked dynamic row and a separator:

```text
[✓] Default · anthropic/claude-sonnet-4
────────────────────────────────────────
anthropic · Parent alternates
openai
google
```

**Quick model setup** grants one agent alternate access to models from the current parent provider in one short flow. Its model checkboxes save immediately, enabling routing and the concrete provider when access is added. It writes the same `enabledProviders` and `agentAccess` state as the full menus; there is no Apply row or separate quick configuration.

**Provider access** is a direct switch list built fresh from `modelRegistry.getAvailable()`. It starts with the locked Parent default and one separator, excludes the current parent provider, and contains no availability diagnostics or Provider detail pages. Its summary counts only enabled alternate providers currently visible as mutable switches; unavailable saved providers and a redundantly persisted current parent do not count.

Saved routing state for providers absent from Pi availability is shown separately as **Saved unavailable providers**. That exception flow can toggle dormant routing state or explicitly delete every saved Agent rule after multiline confirmation. Toggling never deletes rules, zero rule counts are omitted, and the current parent provider is excluded.

After selecting an Agent, its Provider picker shows only providers that passed Provider access and remain available, plus the current parent provider as `Parent alternates`. Disabled or unavailable providers are hidden while their rules remain dormant.

The normal Agent model picker shows only actionable alternates: Provider models from `getAvailable()` intersected with Pi's active model scope, excluding the exact parent model. `All models` and exact-model checkboxes save immediately and remain open at the changed row; there is no Apply row or normal-state status text. Scope-excluded and unavailable models stay hidden, while saved exact IDs remain dormant in configuration and reappear if their prerequisite returns.

**Clean unavailable rules** appears only when a reliable fresh `modelRegistry.getAll()` catalogue proves that saved exact model IDs are missing while their provider remains in the catalogue. Its global multiline confirmation lists every affected Provider, Agent, and model ID, then re-reads the catalogue and removes only IDs still unavailable. Credential or `getAvailable()` loss, scope changes, all-model rules, and an absent/unreliable catalogue provider never create cleanup candidates. Persisted dormant exact IDs remain intact until an explicit rule change or cleanup action.

Current Agent types, Parent default, and effective model access are added automatically to the parent system prompt with Pi's `before_agent_start` hook. Every callable alternate is listed as an exact `provider/model` key, including models allowed by an `All models` rule; wildcard policy summaries are never used as Agent arguments. Alternate authorization and guidance use the current `getAvailable()` keys; catalogue-only models are never advertised or callable. Configuration, parent-model, availability, and scope changes are reflected on the next parent run without `/reload`, a manual briefing, a session message, or an extra LLM turn.

The selected model, parent model, thinking selection, scoped-model state, and background delivery mode are locked when the Agent call is accepted. Running and queued agents retain that invocation snapshot; later settings changes affect only future Agent calls.

## Concurrency

The fallback ceiling is 4 concurrent runs per model. An explicit Model limit replaces that per-model fallback, while a Provider limit is an independent shared hard ceiling across every model from that Provider. A run starts only when both ceilings have room; Model limits may sum above the Provider limit so idle capacity remains shareable.

New Agent calls beyond either ceiling enter `Queued`. Continuing a settled child does not queue: the input remains in the editor and Main shows `Blocked: provider/model concurrency limit reached` until a later successful send or Agent switch.

The Concurrency menu shows only the parent model, currently authorized alternates, and models retained by existing child sessions. Limits outside that actionable inventory remain saved under **Saved inactive limits**, reappear automatically when their prerequisite returns, and are removed only through an explicit user action.

## Settings

Run `/agents` to configure:

- Parent default inheritance, Quick model setup, Provider access switches, unavailable-provider exceptions, and per-agent provider/model access;
- the fallback per-model ceiling, shared Provider ceilings, per-model ceilings, and saved inactive limits;
- background mode, Background delivery (`Auto continue` or `Next natural turn`), grace turns, and default thinking;
- system prompt mode (`replace`, `inherit`, or `custom`) and `AGENTS.md` inclusion;
- implicit skill and extension loading, built-in agents, and visible list statistics;
- agent type inspection, runtime diagnostics, and UI-only status previews for list-layout testing;
- one-shot recovery tests that inject a failure after the next real child session is configured. Injected records show a separate accent-colored `[DEBUG]` badge before their lifecycle status in both the list and child header. The controls and runtime diagnostics are session-local and UI-only; injected failures use a fixed 10-second recovery window, while ordinary recoverable failures keep the normal 30-minute window. The parent LLM can observe the normal Agent call failing, but cannot arm faults, inspect Debug diagnostics, or continue the child through an extra tool.

Settings are stored in `~/.pi/agent/subagents-lite.json`. Custom prompt mode uses `~/.pi/agent/subagents-lite-prompt.md`.

## License

MIT — see [LICENSE](./LICENSE).
