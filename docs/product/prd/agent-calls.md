# Agent calls and Agent catalogue

## User outcomes

The parent LLM can call `Agent`, `StopAgent`, and `AgentStatus` using the existing workflow. Users can maintain built-in and custom Agent types, target a valid Worktree of the parent repository, and inspect the resulting Subagent through the existing Child screen and result delivery behavior.

## Requirements

### REQ-AGENT-001 — Spawn through Agent

The `Agent` tool accepts the existing spawn inputs and returns the existing success or failure outcome. `/agents` remains a management workflow and does not become a second spawn entry point.

### REQ-AGENT-002 — Lock accepted run policy

After authorization, a running or queued call retains its complete Accepted run policy. Later Agent catalogue, Model access, Parent model, scope, Thinking, or operational setting changes affect only future calls.

### REQ-AGENT-003 — Stop and inspect

`StopAgent` stops accepted work according to the current foreground/background rules. `AgentStatus` reports the existing lifecycle and delivery information, including explicit acknowledgement behavior.

### REQ-WORKTREE-001 — Validate Worktree targets

An optional `worktree_path` is accepted only when it resolves to the parent repository or one of its Worktrees. Missing paths, non-directories, non-repositories, and paths from another repository return a specific failure outcome.

### REQ-CATALOGUE-001 — Discover Agent types

Built-in and custom Agent definitions are discovered from their supported sources, merged by the existing precedence rules, and exposed with their effective tool, skill, extension, prompt, model, and runtime settings.

### REQ-CATALOGUE-002 — Disable built-in Agent types safely

Disabling built-in Agent types blocks new calls and on-demand discovery while preserving same-name custom definitions. Existing running and queued calls retain their Accepted run policy.

## Out of scope

- A new user-facing prompt inspection feature.
- A new way for users to start a Subagent without the parent LLM's `Agent` call.
- Changing Agent names, existing tool names, or Worktree validation semantics.

## Acceptance intent

Acceptance examples cover valid and invalid Agent calls, queued and running policy snapshots, foreground interruption, background stopping, built-in/custom name collisions, Worktree validation, and explicit status reads.
