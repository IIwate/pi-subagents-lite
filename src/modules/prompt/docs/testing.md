# Prompt testing

## Primary seam

Test guidance and system-prompt assembly through `prompt/public.ts` with literal serialized requests and exact output examples.

## Required scenarios

- Stable fragment ordering and deterministic output.
- Parent guidance exact callable model keys and required `model` behavior.
- Subagent system prompt modes, Agent instructions, skills, context files, and runtime environment.
- Missing optional source, malformed source, and unavailable policy inputs.
- Inherit mode with a missing, empty, or whitespace-only header fails closed instead of assembling the replace-mode header.
- JSON round-trip validation for assembly requests and results.

## Fixtures and doubles

Use in-memory reader ports and explicit string sources. Do not mock Agent catalogue, Model access, runtime, or Pi modules internally.
