# @iiwate/pi-subagents-lite

**Sub-agents for [pi](https://pi.dev) — schema-first, list-first.**

Spawn specialized agents with isolated sessions, custom tools, and per-type models at minimal token cost. The chat feed stays silent; all agent progress lives in a compact list below the editor.

## Install

```bash
pi install npm:@iiwate/pi-subagents-lite
pi install -l npm:@iiwate/pi-subagents-lite   # project-local
pi -e npm:@iiwate/pi-subagents-lite           # try without installing
```

## Quick Start

The LLM calls `Agent` like any other tool (`StopAgent` stops one, `AgentStatus` lists all). Foreground agents block until done; background agents acknowledge immediately and deliver results to the LLM silently on completion.

Progress appears only in the below-editor agent list (one row per agent, capped at ~6 rows):

- **Empty editor + `↓`** — focus the list; `↑↓` move, `Enter` switches the visible transcript to that agent, `Esc` returns to the editor.
- **`Ctrl+D` on a row** — clear that agent from the list (`Enter` confirms, `Esc` cancels). Running agents are stopped first.
- With a subagent selected, typing in the editor messages that subagent directly; select Main to return.

Model/concurrency settings, stats visibility, and agent-type management live under `/agents`.

## Differences from Upstream

This package is a fork of [luispater/pi-subagents-lite](https://github.com/luispater/pi-subagents-lite) that diverged after upstream v1.5.0. Compared with the upstream `main` branch, this fork:

- uses a single below-editor agent list as the only progress UI (the above-editor tree widget is removed, along with its compact/max-lines settings);
- keeps the chat feed free of `Agent`, `StopAgent`, and `AgentStatus` tool cards; the list owns visible progress and stats;
- starts subagents only through the `Agent` tool; `/agents` remains for settings and diagnostics, without a duplicate manual spawn wizard;
- delivers background completion to the LLM with `display: false` (no purple result card, no toast);
- caps the list height (~6 rows with hidden-row scrolling), slows list/status refresh, and reports in-flight count only via `setStatus`;
- supports manual agent clear from the list (`Ctrl+D`, with confirm) and forces TUI reflow when the list shrinks, a subagent finishes, or the main session ends — reducing blank gaps under classic powerline layouts.

For the shared feature set (custom agent types, model precedence, concurrency limits, and worktrees), see the [upstream README](https://github.com/luispater/pi-subagents-lite#readme).

## License

MIT — see [LICENSE](./LICENSE).
