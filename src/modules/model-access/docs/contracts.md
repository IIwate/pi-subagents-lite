# Model access contracts

## Public boundary

`public.ts` exports TypeBox schemas, derived types, ports, and application entry points. It is the only import path available to runtime, prompt, and settings consumers.

## Implemented schemas

- `ModelAccessFragmentSchema` is the catalogue-owned `modelRouting` fragment.
- `AuthorizeModelCommandSchema` and `AuthorizeModelResultSchema` authorize one Agent call.
- `ThinkingAccessOverrideSchema` and `ThinkingLevelSchema` describe saved and effective Thinking policy.

Effective alternate keys, unavailable-rule cleanup, and Thinking resolution are application entry points that consume the same fragment. Exact fields stay in the TypeBox schemas.

Exact fields are defined once in TypeBox and are not repeated in this document.

## Ports

The module reads serializable Pi availability and parent-model snapshots through narrow ports. Persistence uses the configuration document transaction port; policy calculation never sees filesystem or Pi objects.
