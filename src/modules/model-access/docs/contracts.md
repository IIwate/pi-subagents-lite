# Model access contracts

## Public boundary

`public.ts` exports TypeBox schemas, derived types, ports, and application entry points. It is the only import path available to runtime, prompt, and settings consumers.

## Planned schemas

- `ModelAccessCommand` and `ModelAccessResult`.
- `ModelAccessSnapshot` and `EffectiveModelPolicySnapshot`.
- `ProviderAccessSnapshot`, `ModelScopeSnapshot`, and `ThinkingAccessSnapshot`.
- `ModelAuthorizationResult`.

Exact fields are defined once in TypeBox and are not repeated in this document.

## Ports

The module reads serializable Pi availability and parent-model snapshots through narrow ports. Persistence uses the configuration document transaction port; policy calculation never sees filesystem or Pi objects.
