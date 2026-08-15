# Agent calls and Agent catalogue

## User outcomes

The parent LLM can call `Agent`, `StopAgent`, and `AgentStatus` using the existing workflow. Users can maintain built-in and custom Agent types, target a valid Worktree of the parent repository, and inspect the resulting Subagent through the existing Child screen and result delivery behavior.

## Requirements

### REQ-AGENT-001 — Spawn through Agent

The `Agent` tool accepts the existing spawn inputs and returns the existing success or failure outcome. A prompt source the user cannot see or correct — unavailable inherited parent prompt text — fails the call rather than running under a different prompt mode; an absent custom prompt file, which the settings workflow shows and offers to create, degrades to replace mode with a notice. `/agents` remains a management workflow and does not become a second spawn entry point.

### REQ-AGENT-002 — Lock accepted run policy

After authorization, a running or queued call retains its complete Accepted run policy. Later Agent catalogue, Model access, Parent model, scope, Thinking, or operational setting changes affect only future calls.

### REQ-AGENT-003 — Stop and inspect

`StopAgent` stops accepted work according to the current foreground/background rules. `AgentStatus` reports the existing lifecycle and delivery information, including explicit acknowledgement behavior.

### REQ-AGENT-004 — Deterministic Agent type resolution

A queried Agent type resolves by exact canonical name first, then a unique case-folded canonical match, then a unique display-name match. Any collision returns an explicit tool error listing the stably sorted candidate names and does not spawn. Any outcome short of an exact canonical hit triggers one on-demand rescan of the authorized sources, after which a newly discovered exact name wins over an older case-folded or display-name match.

### REQ-WORKTREE-001 — Validate Worktree targets

An optional `worktree_path` is accepted only when it resolves to the parent repository or one of its Worktrees. The Agent tool validates and resolves it once before on-demand catalogue discovery, then lifecycle consumes that validated snapshot as the Child cwd without probing Git again. Missing paths, non-directories, non-repositories, and paths from another repository return a specific failure outcome.

### REQ-CATALOGUE-001 — Discover Agent types

Built-in and custom Agent definitions are discovered from their supported sources — from authorized sources only, per REQ-CATALOGUE-003 — merged by the existing precedence rules, and exposed with their effective tool, skill, extension, prompt, model, and runtime settings.

### REQ-CATALOGUE-002 — Disable built-in Agent types safely

Disabling built-in Agent types blocks new calls and on-demand discovery while preserving same-name custom definitions. Existing running and queued calls retain their Accepted run policy.

### REQ-CATALOGUE-003 — Project resource trust gate

A session whose Pi context reports the project as not trusted loads only built-in and global Agent definitions: project and worktree definition directories are never scanned, and their types never appear in guidance. When the context reports trusted, project definitions and same-repository worktree definitions load as before; a same-repo worktree inherits the parent session's verdict. Trust is re-read from the context at every session start. The gate does not change Worktree validation semantics or tool execution permissions, and this extension does not promise that Pi shows an explicit trust prompt for these resources — it only respects the boolean the context reports.

## Out of scope

- A new user-facing prompt inspection feature.
- A new way for users to start a Subagent without the parent LLM's `Agent` call.
- Changing Agent names, existing tool names, or Worktree validation semantics. REQ-AGENT-004 changes resolution determinism only; a display name remains a valid unique alias for its Agent type.

## Acceptance intent

Acceptance examples cover valid and invalid Agent calls, queued and running policy snapshots, foreground interruption, background stopping, built-in/custom name collisions, one-pass Worktree validation and discovery, and explicit status reads.
