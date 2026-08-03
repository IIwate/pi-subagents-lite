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
- `AgentStatus` — list current and completed agents without polling or waiting.

Progress appears in the below-editor list, capped at six visible entries and scrolled around the focused row. Status follows the agent name in parentheses; model, provider, and thinking appear before usage stats. `Needs input` agents sort first and `Done` agents last:

```text
› ● Main
  ○ Security (Needs input)  Audit authentication       claude-sonnet-4 · anthropic · high · 81 calls · 36m
  ○ Explore (Running)  Inspect the project              gpt-5.4 · openai-codex · high · 4 calls · 25s
```

- `›` marks the keyboard-highlighted row.
- `●` marks the active transcript; `○` marks inactive rows.
- Status values include `Queued`, `Running`, `Done`, `Stopped`, `Turn limit`, `Aborted`, `Error`, and `Needs input`.
- With an empty editor, press `↓` to focus the list. Use `↑`/`↓` to move, `Enter` to activate, and `Esc` to return to the editor.
- Press `Ctrl+D` on an inactive subagent to clear it; `Enter` confirms and `Esc` cancels. Running agents are stopped first.
- While a subagent is active, editor input is routed to that session. Activate `Main` to return to the parent transcript.
- `Needs input` means the run failed after a live child session already existed. Select it and send another prompt to continue the same in-memory session. The normal recovery window is 30 minutes; selecting that child view pauses its remaining recovery time, and switching back to `Main` resumes the same countdown. This is not persisted across `/reload` or process exit, and the parent LLM has no continuation tool.

Each new subagent starts without the parent's conversation history. Background results are delivered to the parent LLM silently when ready; do not poll, sleep, or repeatedly call `AgentStatus` while waiting.

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

With **Model routing** OFF (`/agents` > Settings > Model routing), any other model is rejected. With routing ON, an alternate model is authorized only when all of these are true:

- its provider is globally enabled for routing;
- the selected agent type has access to that provider;
- the agent's provider rule allows all models or the exact model ID;
- Pi reports the exact model through `modelRegistry.getAvailable()`;
- the model is inside Pi's active model scope.

Alternate models must be passed explicitly through the Agent tool. A rejected explicit choice is never replaced silently with the parent model. The parent provider receives no implicit access to its other models; same-provider alternatives use the same explicit provider and agent rules as every other alternate model.

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
openai       All models
google       2 models
```

**Quick model setup** grants one agent alternate access to models from the current parent provider in one flow. It writes the same `enabledProviders` and `agentAccess` state as the full menus; there is no separate quick configuration.

Provider pickers use `modelRegistry.getAvailable()` plus providers already named by saved routing state. They never expose the full `getAll()` built-in catalogue as ordinary choices. Available built-in and third-party providers are listed together under **Available providers**; saved providers missing from Pi availability remain manageable under **Saved but unavailable**.

Disabling routing for a provider or losing its credentials/availability preserves every agent rule as dormant configuration. Provider maintenance shows the routing switch, Pi availability, and effective access separately. Model rows distinguish **Active**, **Available**, **Out of current scope**, **Provider unavailable**, and **Unavailable catalogue ID**. Cleanup uses a reliable `getAll()` catalogue snapshot only: **Clean unavailable rules** removes exact IDs missing from a catalogue provider that is still present, rechecks at confirmation time, and never treats authentication loss or scope loss as catalogue removal. **Delete saved access rules** remains the separate action that removes that provider from every agent policy.

Current Agent types, Parent default, and effective model access are added automatically to the parent system prompt with Pi's `before_agent_start` hook. Alternate authorization and guidance use the current `getAvailable()` keys; catalogue-only models are never advertised or callable. Configuration, parent-model, availability, and scope changes are reflected on the next parent run without `/reload`, a manual briefing, a session message, or an extra LLM turn.

The selected model, parent model, thinking selection, and scoped-model state are locked when the Agent call is accepted. Running and queued agents retain that invocation snapshot; later settings changes affect only future Agent calls.

## Settings

Run `/agents` to configure:

- Parent default inheritance, Quick model setup, globally enabled routed providers, and per-agent provider/model access;
- default, per-provider, and per-model concurrency limits;
- background mode, grace turns, and default thinking;
- system prompt mode (`replace`, `inherit`, or `custom`) and `AGENTS.md` inclusion;
- implicit skill and extension loading, built-in agents, and visible list statistics;
- agent type inspection, runtime diagnostics, and UI-only status previews for list-layout testing;
- one-shot recovery tests that inject a failure after the next real child session is configured. The controls and runtime diagnostics are session-local and UI-only; injected failures use a fixed 10-second recovery window, while ordinary recoverable failures keep the normal 30-minute window. The parent LLM can observe the normal Agent call failing, but cannot arm faults, inspect Debug diagnostics, or continue the child through an extra tool.

Settings are stored in `~/.pi/agent/subagents-lite.json`. Custom prompt mode uses `~/.pi/agent/subagents-lite-prompt.md`.

## License

MIT — see [LICENSE](./LICENSE).
