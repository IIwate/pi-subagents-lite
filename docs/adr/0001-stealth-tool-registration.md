# Stealth tool registration

The Agent tool is registered at extension init time with a minimal schema: `description: "."`,
no `promptSnippet`, no `promptGuidelines`, and mostly undescribed parameters. The optional model
parameter is resolved inside tool execution so its source remains available across queue waits.
The LLM learns detailed usage from the `/agents` briefing rather than verbose tool descriptions.

## Why

Registering the Agent tool at runtime (the `subagent-lazy` pattern) calls `registerTool()`
→ `refreshTools()` → `setActiveToolsByName()` → system prompt rebuild. llama.cpp renders
tool definitions into the prompt text via its Jinja2 chat template, so adding a tool changes
the token sequence and invalidates the KV cache prefix match.

Registering at init time freezes the tool set from turn 1. No mid-session tool changes,
no system prompt rebuilds, no cache invalidation.

Resolving the model inside tool execution keeps the schema lean while preserving whether the
choice was explicit, automatic, or inherited. That provenance lets queued starts recheck a
revoked cross-provider permission without confusing an automatic override with a user choice.

## Trade-off

The minimal schema (`description: "."`, no parameter descriptions) means the LLM must infer
usage from the tool name and parameter names alone. In practice this works — models use the
Agent and StopAgent tools without issues. The optional `/agents` briefing can supplement
understanding when the LLM needs to discover available agent types, but is not required for
basic tool invocation.

Registering at init time (rather than runtime) avoids system prompt rebuilds and KV-cache
invalidation on mid-session tool changes.
