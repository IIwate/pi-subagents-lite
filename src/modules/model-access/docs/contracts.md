# Model access contracts

## Public boundary

`public.ts` exports TypeBox schemas, derived types, and application entry points. It is the only import path available to runtime, prompt, and settings consumers.

## Implemented schemas

- `ModelAccessFragmentSchema` is the model-access-owned `modelRouting` fragment.
- `AuthorizeModelCommandSchema` and `AuthorizeModelResultSchema` authorize one Agent call.
- `ThinkingAccessOverrideSchema` and `ThinkingLevelSchema` describe saved Thinking policy. `ThinkingLevelSchema` is the single definition of the level vocabulary for the whole repository; runtime run policy, session events, the Agent tool parameter, and settings all embed it rather than restating the literals, and `CANONICAL_THINKING_LEVELS` derives its ascending order from the schema.
- `ThinkingAccessPolicySchema` and `ThinkingSelectionSchema` describe the resolved envelope and one selection against it. They are schema-defined because the prompt module renders the envelope into parent guidance, so it leaves this module.
- `ResolveThinkingAccessQuerySchema` embeds `ThinkingLevelSchema` for parent/scoped thinking. Host dirty strings are canonicalized at the query seam before Check; the outbound policy is still Checked.

Parse, apply, and query functions consume that fragment. Persistence goes through the configuration module's fragment commits; the composition seam (`bootstrap/model-access.ts`) reads the fragment and commits one atomic policy transition per settings verb. Exact fields stay in the TypeBox schemas. Canonical keys, scope-snapshot helpers, and authorization error text are also exported from `public.ts` so leftover `src/models` is not a second owner.

## Ports

Phase 2 has no model-access ports directory. Hosts pass serializable availability, scope, and supported Thinking levels into public functions.
