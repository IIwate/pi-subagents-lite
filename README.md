# Differences from Upstream

This package is a fork of [luispater/pi-subagents-lite](https://github.com/luispater/pi-subagents-lite) that diverged after upstream v1.5.0. Compared with the upstream `main` branch, this fork:

- uses a single below-editor agent list as the only progress UI (above-editor tree disabled);
- keeps the chat feed free of `Agent` tool cards (silent tool render); list owns progress and stats;
- delivers background completion to the LLM with `display: false` (no purple result card, no toast);
- caps the list height (~6 rows with hidden-row scrolling), slows list/status refresh, and reports in-flight count only via `setStatus`;
- supports manual agent clear from the list (`Ctrl+D`, with confirm) and forces TUI reflow when the list shrinks, a subagent finishes, or the main session ends — reducing blank gaps under classic powerline layouts.
