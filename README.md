# @iiwate/pi-subagents-lite

Lightweight subagents for [Pi](https://pi.dev) with isolated sessions, per-agent tools and models, background execution, and a responsive TUI navigator. Subagent activity, tool calls, and completions stay out of your main chat until you need them.

## Features

- **Isolated Subagent Sessions**: Run multi-step tasks with independent conversation context, tools, and model settings.
- **Background & Foreground Execution**: Spawn background agents that report back automatically, or foreground agents that block the current turn.
- **Native MCP & Tool Bus**: Out-of-the-box support for MCP, Codemode, and ToolSearch with independent connection lifecycles and read-only protections.
- **Model Routing & Thinking Access**: Inherit the parent model by default, or authorize alternate providers and models with fine-grained thinking budgets.
- **TUI Below-Editor Navigator**: Monitor running, queued, and completed agents directly below the editor with full mouse, wheel, and keyboard support.
- **Steering & Explicit Takeover**: Send steering guidance mid-run (`Enter`), take manual control (`Alt+T`), and selectively deliver chosen messages (`Alt+S`) back to the parent.
- **Hierarchical Concurrency**: Enforce model- and provider-level concurrency limits with automatic queuing.
- **Experimental Observation Packing**: Opt-in context compression for large tool results with stable placeholders and paged recall (`obs_recall`).

## Install

Requires Pi 1.x and Node.js 22.19+.

Child tasks use independent pi-durable SQLite sessions under `~/.pi/agent/subagents-lite-v3/durable/`. Existing 0.99.x JSONL child sessions are not read or migrated. Parent Pi sessions and extension configuration keep their own storage.

```bash
pi install npm:@iiwate/pi-subagents-lite
pi install -l npm:@iiwate/pi-subagents-lite   # project-local
pi -e npm:@iiwate/pi-subagents-lite           # try for one run
```

## Quick Look

Once subagents are active, progress appears in the interactive list below the editor:

```text
› ● Main (1 running · 3 total · Alt+A collapse)
  ○ Security (Error)  Audit authentication             anthropic · claude-sonnet-4 · high · 81 calls · 36m
  ○ Explore (Running)  Inspect the project              openai-codex · gpt-5.4 · high · 4 calls · 25s
  ◇ Reviewer (Done)  Preserve this review               openai-codex · gpt-5.4 · high · 12 calls · 2m
```

### Keyboard & Mouse Shortcuts

When the list is expanded and the editor is empty, press `↓` to focus the list:

| Shortcut | Action |
|---|---|
| `↑` / `↓` | Navigate between subagents (also supports mouse wheel and clicks) |
| `Enter` | Activate and inspect the selected subagent session |
| `Space` | Pin / unpin subagent (pinned agents survive automatic cleanup) |
| `Alt+T` | Explicitly take over the active subagent; detach from a foreground wait |
| `Alt+S` | Select existing messages from a taken-over subagent to deliver to Main |
| `Alt+M` | Return to Main session from any subagent view |
| `Alt+A` | Toggle subagent list expanded / collapsed |
| `Alt+Up` / `Alt+Q` | Pull queued steering messages back into the editor for editing |
| `Ctrl+D` | Remove a completed or stopped subagent |
| `Esc` | Stop the active child operation while viewing it; or return focus to the editor |

### Subagent Commands

While viewing a subagent, `/` completion and submitted commands belong to the active subagent, even when another list row is highlighted.

| Command | Action |
|---|---|
| `/help` | Show subagent commands |
| `/status` | Show identity, model, control mode, progress, and queue count |
| `/queue` | Inspect queued messages; use `Alt+Up` to restore them to the editor |
| `/stop` | Stop the current operation |
| `/takeover` | Take manual control, leaving subsequent results for explicit delivery |
| `/deliver` | Open the existing message selector for an eligible subagent |
| `/main` | Return to Main and its native commands |

Commands take no arguments. Their replies are temporary UI output, cleared by the next ordinary input or a view change. Unknown commands and `!` shell input receive a local rejection. Return to Main before using its native commands, including model/session changes and shell execution.

## Tools for LLM

The extension registers three tools for the parent model:

- `Agent({ prompt, agent?, model?, thinking?, run_in_background?, cwd? })`: Spawn a specialized subagent. `cwd` supports relative paths, external repositories, and git worktrees.
- `StopAgent({ agent_id })`: Terminate a running or queued subagent.
- `AgentStatus({ agent_id? })`: Inspect active subagents or retrieve an exact completion result.

## Custom Agents

Define project or user-wide agents using Markdown files with YAML frontmatter:

- **User agents**: `<Pi agent directory>/agents/*.md` (defaults to `~/.pi/agent/agents/*.md`)
- **Project agents**: `.pi/agents/*.md` (loaded when the project is trusted)

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
---

Review the requested changes. Prioritize correctness, regressions, and missing tests.
```

Supported frontmatter fields: `tools`, `exclude_tools`, `mcp`, `extensions`, `skills`, `preload_skills`, `thinking`, `max_turns`, and `max_tokens`. Built-in agents (`general-purpose`, `Explore`) can be customized or disabled.

## MCP & Extension Tools

General-purpose subagents automatically inherit Pi's native MCP servers, codemode, and tool-search—even when ordinary extension loading is disabled.

- **Isolation**: Each subagent manages its own independent connections; exclusive or interactive tools remain constrained.
- **Safety**: Explore and restricted agents strictly preserve their read-only and allowlist boundaries.
- **Asynchronous Discovery**: Deferred tools discovered via `tool_search` persist across session reloads.

Tool lists accept `*` patterns matching the entire tool name. Other characters are literal. Source-qualified entries such as `my-extension/search*` match only that extension's tools. Quote patterns in YAML:

```yaml
tools:
  - read
  - codemode
  - "mcp__docs__*"
```

Patterns also apply to tools discovered later and survive task restoration. `exclude_tools: ["mcp__docs__remove*"]` filters the default allowed set; an explicit `tools` list takes precedence over `exclude_tools`. Defaults and restricted agents retain their existing permissions. Listing `codemode` alone does not authorize MCP tools.

Set `mcp: false` in an Agent's frontmatter to disable the built-in MCP extension before it creates connections. Its tools are absent from declarations, tool search, and codemode discovery. Local tools and codemode remain available according to the tool list. Omitted `mcp` or `mcp: true` follows Pi's enabled-source configuration. Restored tasks retain their accepted MCP selection even if the Agent definition changes. This setting does not prevent ordinary extensions from making their own connections or remove tool names already present in inherited prompts or history.

## Settings

Run `/agents` in Pi to open the interactive settings menu:

- **Model Routing**: Authorize specific providers and models for subagents with dynamic prompt guidance.
- **Concurrency**: Set per-model and shared provider concurrency limits (default: 10).
- **Spawn Options**: Configure default thinking levels, force-background mode, and grace turns.
- **System Prompt**: Choose prompt mode (`replace`, `inherit`, `custom`) and AGENTS.md inclusion.
- **Display Settings**: Configure list visibility, expanded defaults, and stats line metrics.
- **Experimental Features**: Opt in to experimental mechanisms such as Observation Packing (`obs_recall`).

Configuration is saved atomically in `subagents-lite-v3.json` inside Pi's agent directory.

## License

MIT — see [LICENSE](./LICENSE).
