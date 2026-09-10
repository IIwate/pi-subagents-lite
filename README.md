# @iiwate/pi-subagents-lite

Lightweight subagents for [pi](https://pi.dev) with isolated sessions, per-agent tools and models, background execution, and a keyboard-driven list below the editor. Subagent activity, tool calls, and completions stay out of your main chat until you need them.

## Features

- **Isolated Subagent Sessions**: Run multi-step tasks in dedicated, sandboxed sessions without polluting the parent conversation.
- **Background & Foreground Execution**: Spawn background agents that report back when finished, or foreground agents that block the current turn.
- **Model Routing & Thinking Access**: Inherit the parent model by default, or authorize alternate providers and models with fine-grained thinking budgets.
- **TUI Below-Editor Navigator**: Monitor running, queued, and completed agents directly below the editor with responsive terminal layouts.
- **Human Takeover & Selective Delivery**: Step into any subagent to steer its execution, and selectively deliver message snapshots (`Alt+S`) back to the parent session.
- **Hierarchical Concurrency**: Enforce model- and provider-level concurrency limits with automatic queuing.
- **Cross-Platform**: Seamless support for macOS, Linux, and Windows (with native PowerShell tool adaptation).

## Install

Requires Pi 0.84.3+.

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

### Keyboard Shortcuts

When the list is expanded and the editor is empty, press `↓` to focus the list:

| Shortcut | Action |
|---|---|
| `↑` / `↓` | Navigate between subagents |
| `Enter` | Activate and inspect the selected subagent session |
| `Space` | Pin / unpin subagent (pins protect from automatic cleanup) |
| `Alt+S` | Open delivery selector to choose message snapshots to return to Main |
| `Alt+M` | Return to Main session from any subagent |
| `Alt+A` | Toggle subagent list expanded / collapsed |
| `Alt+Up` | Pull queued steering messages back into the editor for editing |
| `Ctrl+D` | Remove a completed or stopped subagent |
| `Esc` | Return focus to the editor, or interrupt an active foreground agent |

## Tools for LLM

The extension registers three tools for the parent model:

- `Agent({ prompt, agent?, model?, thinking?, run_in_background?, worktree_path? })`: Spawn a specialized subagent.
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

Supported frontmatter fields include `tools`, `exclude_tools`, `extensions`, `skills`, `preload_skills`, `thinking`, `max_turns`, and `max_tokens`. Built-in agents (`general-purpose`, `Explore`) can be customized or disabled.

## Settings

Run `/agents` in Pi to open the interactive settings menu:

- **Model Routing**: Subagents use the exact parent model by default. Turn routing ON to authorize specific providers and models with dynamic system prompt guidance.
- **Concurrency**: Configure per-model and shared provider concurrency limits (defaults to 4 concurrent slots per model).
- **Spawn Options**: Set default thinking levels, force-background mode, and grace turns.
- **Display Settings**: Configure whether the subagent list starts expanded, and toggle visible metrics.

Global configuration and custom system prompts are stored in `subagents-lite.json` and `subagents-lite-prompt.md` inside Pi's agent directory (`getAgentDir()`).

## License

MIT — see [LICENSE](./LICENSE).
