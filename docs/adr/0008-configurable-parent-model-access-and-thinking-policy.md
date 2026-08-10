---
status: accepted
---

# Configurable parent model access and model-bound thinking policy

Agent types will no longer receive unconditional access to the exact parent model. Each agent type will instead own an explicit Parent model access policy, defaulting to allowed for backward compatibility, while thinking authorization will be attached to the agent type and exact model identity. This separates dynamic parent-model permission, alternate-model routing, and thinking policy without introducing automatic model assignment or fallback.

## Decision

### Model access terminology and configuration

`/agents` will rename the top-level **Model routing** area to **Model access**. Its first setting is labeled **Alternate models**, remains the switch that enables non-parent models, and defaults OFF for a fresh installation; Model access is the broader area containing Parent model access, Provider access, per-agent model access rules, and thinking policies. Provider and Agent/model rules are explicit allowlists rather than model assignments.

The canonical per-agent configuration will distinguish these concerns:

```ts
interface AgentModelAccess {
  /** Omitted means allowed, preserving existing behavior. */
  parentModelAccess?: boolean;
  providers: Record<string, ProviderModelAccess>;
  /** Exact canonical provider/model key to a saved policy override. */
  thinking?: Record<string, ThinkingAccessOverride>;
}

interface ThinkingAccessOverride {
  allowed: ThinkingLevel[];
  default: ThinkingLevel;
}
```

Thinking overrides are independent of current alternate access. A saved override follows the exact model across Parent default and alternate roles, remains dormant while the model is not callable, and is deleted only by an explicit reset or relevant destructive cleanup.

### Parent model access

Parent model access is evaluated per agent type when an Agent call is accepted:

- Omitted `parentModelAccess` means allowed.
- When allowed, omitting `model` selects the exact model active in the parent session.
- When denied, omitting `model` fails immediately; no alternate model is selected automatically.
- When denied, explicitly passing the exact parent model also fails, even if an ordinary Provider/model rule would otherwise authorize that key.
- Parent denial applies to the model that is the exact parent at acceptance time. A saved alternate rule for that model becomes dormant while it is the parent and becomes effective again after the parent switches away.
- Parent model changes affect only future Agent calls. Queued and running calls retain the accepted model, Parent identity, thinking policy, scope, and authorization snapshot.

Model routing OFF disables alternates but does not change Parent model access. An agent type with Parent model access denied and no effective alternate is valid configuration but currently unavailable.

### Explicit model selection

The Agent tool will accept only canonical `provider/model` keys. Bare model IDs and `model:thinking` suffixes will be removed. Thinking will be expressed only through the separate `thinking` argument.

A non-parent model remains subject to all existing gates: Model routing ON, explicit Provider access, per-agent Provider/model authorization, Pi availability, and active Model scope. The current parent Provider does not bypass an explicit Provider restriction for its alternate models; exact Parent default use remains governed independently by Parent model access. Rejected or omitted choices never fall back to the parent or to another authorized model.

### Thinking policy

Thinking values are Pi's canonical levels only: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Provider-specific values remain the responsibility of Pi model metadata and `thinkingLevelMap`.

Every callable agent type and exact model has an effective Thinking access rule:

- A saved override supplies a non-empty `allowed` set and a `default` member of that set.
- The saved override follows the exact model whether it is currently Parent default or alternate.
- Without an override, a Parent default allows every model-supported level and defaults to the parent session's current effective thinking.
- Without an override, an alternate allows every model-supported level and defaults to Pi's `clampThinkingLevel(model, "high")` result.
- An explicit Agent `thinking` outside the effective allowed set is rejected with the allowed levels; it is never silently clamped or replaced.
- A Pi Model scope thinking pin is authoritative for Parent and alternate models. It replaces the effective allowed set with that one level and makes the same level the effective default. A different explicit Agent thinking value is rejected.
- A saved override that has no valid allowed/default combination under current model capability suspends that exact model for the agent type without rewriting the saved policy.

An All models Provider rule continues to authorize current and future available models. Models without an exact thinking override use the dynamic baseline; exact overrides may be saved beneath the All models rule.

The existing global `defaultThinking` setting and custom Agent frontmatter `thinking` field will be removed. Parent defaults inherit the parent session when no exact override exists; alternate defaults come from the exact model policy. Retired fields are ignored with an explicit warning rather than supported through a compatibility precedence layer.

### User interface

The Model access page remains useful while Model routing is OFF:

- **Quick model setup** remains visible and continues to show only alternate models from the current Parent Provider. Selecting access atomically enables Model routing, enables that Provider, and writes the Agent/model rule.
- **Agent access** remains visible so Parent model access can be changed. While routing is OFF, its Agent Provider page shows the Parent default control without alternate Provider rows.
- The ordinary Provider and alternate-model configuration remains subject to the full Routing → Provider → Agent → Model hierarchy.

The Agent Provider page will make its first row actionable. The domain concept remains Parent model access, while the user-facing label states the behavior directly:

```text
[x] Use parent model · openai/gpt-5 · high
────────────────────────────────────────────────
openai
anthropic
```

On Parent default and ordinary model rows:

- `Space` toggles access.
- `Enter` opens the exact model's thinking detail when applicable.

The thinking detail is one list of model-supported levels:

```text
[x] off
[x] low
[x] medium
[x] high · default
[ ] xhigh

Space allow · Enter default
```

The default level receives visually prominent accent/bold treatment. `Space` adds or removes a level; `Enter` sets the default and ensures the level is allowed. Removing the current default automatically selects a new default from the remaining allowed levels using the same high-normalization ordering. The final allowed level cannot be removed. `Reset baseline` deletes the saved override.

The Provider access page keeps its Parent default row informational because that page has no agent-type scope, but it exposes the current parent Provider as an ordinary mutable alternate-Provider row; exact Parent access is not changed there. Model access changes continue to persist immediately without an Apply step.

The bottom reset action restores the complete fresh-install Model access state: Parent model access overrides are removed (default ON), Model routing is OFF, Provider and Agent/model rules are empty, and thinking overrides are removed.

### Agent guidance and failures

Agent guidance will distinguish callable and unavailable agent types:

- Agent types with Parent model access or at least one effective alternate remain available.
- Agent types without any callable model appear under `Unavailable agent types` with `no authorized model`.
- When Parent model access is denied but alternates exist, guidance states that `model` is required.
- Every advertised alternate uses an exact canonical key and includes its effective allowed/default thinking summary. Scope-pinned models show the one mandatory level.

Calling an unavailable agent, omitting a required model, explicitly selecting a denied Parent default, selecting an unauthorized model, or requesting disallowed thinking returns a direct Agent tool error. The runtime does not substitute another model or thinking level.

## Consequences

This partially supersedes ADR 0005's decisions that the exact parent model is always available and that omission of `model` always selects it. It also removes the current-parent Provider's global-gate bypass and related Provider-list exception for alternate models. The explicit Provider access gate, Pi availability, Model scope, explicit alternate authorization, and accepted-work snapshot decisions from ADR 0005 remain in force.

The redesign is a breaking change because it removes bare model IDs, `model:thinking`, global `defaultThinking`, and Agent frontmatter `thinking`. Existing Parent behavior remains compatible because absent `parentModelAccess` means allowed, and existing model access rules receive the dynamic thinking baseline without migration. The release should use a new major version and warn clearly about retired thinking fields.
