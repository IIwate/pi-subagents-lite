# @iiwate/pi-subagents-lite

Lightweight subagents for [pi](https://pi.dev), with isolated sessions, per-agent tools and models, background execution, and a keyboard-driven list below the editor. Agent tool calls and completion delivery stay out of the chat UI.

## Install

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

Progress appears in the below-editor list, capped at six visible entries and scrolled around the focused row. Each row keeps a fixed status column before the stats:

```text
› ● Main
  ○ Explore   Inspect the project       Running       4 calls · 25s
  ○ Security  Audit authentication      Needs input  81 calls · 36m
```

- `›` marks the keyboard-highlighted row.
- `●` marks the active transcript; `○` marks inactive rows.
- Status values include `Queued`, `Running`, `Done`, `Stopped`, `Turn limit`, `Aborted`, `Error`, and `Needs input`.
- With an empty editor, press `↓` to focus the list. Use `↑`/`↓` to move, `Enter` to activate, and `Esc` to return to the editor.
- Press `Ctrl+D` on an inactive subagent to clear it; `Enter` confirms and `Esc` cancels. Running agents are stopped first.
- While a subagent is active, editor input is routed to that session. Activate `Main` to return to the parent transcript.
- `Needs input` means the run failed after a live child session already existed. Select it and send another prompt to continue the same in-memory session. The recovery window is 30 minutes; after that the row can be cleaned up. This is not persisted across `/reload` or process exit, and the parent LLM has no continuation tool.

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
model: provider/model-id
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
- Runtime: `model`, `thinking`, `max_turns`, `max_tokens`.

Frontmatter supports flat values and lists, not nested YAML objects. Extension tools may be selected with `extension/tool` or `extension/*`. Subagents cannot spawn further subagents.

## Agent Options

`Agent` accepts:

- `prompt` — required task text.
- `description` — short list label; defaults to the first prompt line.
- `agent` — agent type; defaults to `general-purpose`.
- `model` — `id`, `provider/id`, or either form with a `:thinking` suffix. The model must resolve exactly and remain inside Pi's active model scope.
- `thinking` — a non-empty provider thinking level; common values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
- `run_in_background` — return immediately and notify the parent when complete.
- `worktree_path` — the parent repository's main checkout or a linked worktree from the same repository. Its `.pi/agents/` directory is scanned for that spawn.

Model selection precedence is: explicit `model` option, session override, persisted override, agent frontmatter, then the parent model.

## Settings

Run `/agents` to configure:

- global and per-type model overrides;
- default, per-provider, and per-model concurrency limits;
- background mode, grace turns, and default thinking;
- system prompt mode (`replace`, `inherit`, or `custom`) and `AGENTS.md` inclusion;
- implicit skill and extension loading, built-in agents, and visible list statistics;
- agent type inspection and diagnostic briefing.

Settings are stored in `~/.pi/agent/subagents-lite.json`. Custom prompt mode uses `~/.pi/agent/subagents-lite-prompt.md`.

## License

MIT — see [LICENSE](./LICENSE).
