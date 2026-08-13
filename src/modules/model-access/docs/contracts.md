# Model access contracts

## Public boundary

`public.ts` exports TypeBox schemas, derived types, and application entry points. It is the only import path available to runtime, prompt, and settings consumers.

## Implemented schemas

- `ModelAccessFragmentSchema` is the model-access-owned `modelRouting` fragment.
- `AuthorizeModelCommandSchema` and `AuthorizeModelResultSchema` authorize one Agent call.
- `ThinkingAccessOverrideSchema` and `ThinkingLevelSchema` describe saved and effective Thinking policy.

Parse, apply, and query functions consume that fragment. Persistence still goes through ConfigStore until Phase 7. Exact fields stay in the TypeBox schemas.

## Ports

Phase 2 has no model-access ports directory. Hosts pass serializable availability, scope, and supported Thinking levels into public functions.
