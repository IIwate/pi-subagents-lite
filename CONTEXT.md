# pi-subagents-lite

A lightweight pi extension that lets the LLM spawn autonomous child agents for complex tasks. Focused fork of pi-subagents with reduced surface area — no scheduling, no join modes.

## Language

### Core concepts

**Subagent**:
An autonomous child agent spawned from the parent conversation via the Agent tool.
_Avoid_: Child agent, worker, task agent

**Agent type**:
A named configuration (general-purpose, Explore, or custom) defining a subagent's tool set, skills, system prompt, and default model.
_Avoid_: Agent kind, agent class

**Agent briefing**:
A user message sent via `/agents` that teaches the LLM about available agent types and how to use the Agent tool. The LLM learns from conversation context, not from the tool schema.
_Avoid_: Agent documentation, tool description

**Stealth tool**:
A tool registered with minimal schema (description ".", no promptSnippet, no promptGuidelines). Usage is taught exclusively through the agent briefing.
_Avoid_: Hidden tool, minimal tool

### Configuration

**Model override**:
A user-configured model preference (per-type or global) that takes precedence over any built-in or frontmatter default. Set via `/agents` > Model settings.
_Avoid_: Model injection, model preference

**Model scope**:
The active allowlist of models from pi (`--models` CLI or settings `enabledModels` / `/scoped-models`). Subagent spawns may only activate models in this list; menus are filtered to it. Empty/unset scope means unrestricted.
_Avoid_: Enabled models list, model filter

**Grace turns**:
Additional turns allowed after the soft turn limit steer message before hard abort. Default 6, configurable via `/agents` > Model settings.
_Avoid_: Grace period, extra turns

### Worktrees

**Worktree**:
A linked git worktree of the same repository as the parent, distinguished by its `--git-dir` pointing outside the worktree root. The target of the `worktree_path` Agent tool param.
_Avoid_: Git worktree, sibling worktree

**Worktree path**:
The resolved absolute filesystem path passed to the `worktree_path` param. Used as the subagent's working directory for its session, resource loader, and system prompt.

### Runtime

**Nudge**:
A completion notification delivered to the parent session after a background agent finishes. Batched with a 200ms hold to coalesce rapid completions.
_Avoid_: Callback, notification

## Relationships

- An **Agent type** has an optional **Model override**
- A **Subagent** is spawned from one **Agent type**
- A **Subagent** model must be inside the active **Model scope** when one is set
- A **Subagent** may run in a **Worktree** of the parent's repo
- An **Agent briefing** describes all available **Agent types** to the LLM
- A **Stealth tool** requires an **Agent briefing** before the LLM can use it
- A **Nudge** is emitted when a background agent completes or errors
- **Grace turns** are added to the max turns limit to determine when a steered agent is hard-aborted
- A **Worktree path** is the absolute resolved path passed via `worktree_path`
- The `worktree_path` tool param is taught to the LLM via the **Agent briefing**

## Product boundaries

- The `Agent` tool is the only spawn entry point. `/agents` owns settings and diagnostics, not a second user-driven spawn flow. Revisit only if users need to start agents without involving the parent LLM.
- A failed subagent with a settled in-memory session remains available for the existing list-driven user interaction flow for 30 minutes, or until manual clear or parent shutdown. This is not persisted resume, and the parent LLM does not receive a continuation tool.
- Debug may arm a session-local, one-shot fault for the next real child session. The injected record may carry its own short recovery TTL, but Debug neither creates a second spawn path nor exposes lifecycle control to the parent LLM.
- Recoverable-failure presentation is local-only. External transports such as webhooks, Telegram, and email are deferred until a concrete consumer exists; future notifications must not include prompts, transcripts, source code, or findings by default.
- Input usage accumulates provider-reported values without a vLLM-specific delta heuristic. Revisit only when a supported backend demonstrably reports cumulative prompt tokens without usable cache accounting.

## Test boundaries

- `bun run test` is the Windows local fast lane and excludes `test/linux/**`.
- `bun run test:ci` runs the complete suite; GitHub Actions executes it on Ubuntu.
- Only assertions that depend on POSIX semantics, such as Unix mode bits, belong in `test/linux/`.
- Cross-platform contracts, such as normalized path separators, stay in the normal suite; fix their expectations instead of hiding them in the Linux lane.
