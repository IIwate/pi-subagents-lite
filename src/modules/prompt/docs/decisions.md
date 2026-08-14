# Prompt support decisions

## Current

- Agent guidance and Subagent system prompt are distinct outputs with one source owner.
- Prompt assembly is deterministic and receives explicit snapshots; it has no global refresh or persistence.
- Parent guidance is injected per run through Pi's `before_agent_start` hook while the registered tool schema stays minimal and frozen (see [stable stealth tool registration](../../../../docs/architecture/decisions.md)). The injected block is compact and deterministic: stable sorting keeps the suffix byte-stable while effective state is unchanged, so the prompt-cache prefix is invalidated only by real authorization, parent-model, registry, scope, or catalogue changes.
- Guidance advertises only what is callable: exact canonical `provider/model` keys (all-model rules are enumerated against current availability and scope, never as wildcards), the parent default selected by omitting `model`, and the rule that rejected explicit choices are never replaced silently. Disabled providers, unavailable, and out-of-scope models are not advertised. An agent type with no saved rule is advertised with the parent default alone, because per-agent Provider rules are the only source of alternates; agents whose parent access is denied are advertised as requiring an explicit `model`, and agents with neither are listed as unavailable.
- There is no manual briefing command, injected conversation message, or Debug-menu guidance action: guidance is runtime behavior, not a user-maintained message, and per-run injection is what removes stale briefings and refresh steps.
- Prompt material is inspectable in source and module documentation, not through a new product capability.
- Custom prompt and context-file bytes are read in `platform/fs` and enter prompt assembly as strings. Their [failure boundaries](./prompt-sources.md) are asymmetric on purpose: an unavailable inherited parent prompt fails the run, an unreadable custom file degrades to replace mode with a notice.
- The Pi adapter maps skill blocks onto `assembleSubagentPrompt`; the leftover `src/prompt/prompts.ts` wrapper is retired. Inherit mode remains a first-class assembly request.

## Superseded

- Consumer-owned prompt fragments and independently projected Model access guidance are retired. The [prompt source inventory](./prompt-sources.md) owns every extension-controlled fragment and its ordering.

## Implementation-only

- Existing helper names, prompt file locations, and Pi callback closures are not public prompt concepts.
