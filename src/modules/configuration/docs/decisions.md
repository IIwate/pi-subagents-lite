# Configuration support decisions

## Current

- Configuration owns source precedence and atomic document transactions, not product policy.
- Each capability owns its fragment schema, defaults, normalization, and update command.
- The existing unversioned persisted JSON shape is preserved during the refactor.
- Generic path reads return opaque JSON values; the consuming capability validates and interprets them.
- The HOME call site passes three candidates: environment, `.env`, and the OS home fallback. It does not pass a persisted-file value, because that file's path is derived from HOME.

## Superseded

- `ConfigStore` as the owner of persistence, capability policy, and manager or navigator side effects is retired. The [operations contract](./operations.md) owns precedence and transaction behavior.

## Implementation-only

- The shared section IO in `bootstrap/configuration.ts` delegates every fragment read and commit to this module, so there is exactly one in-memory document, one observed revision, and one write path. Phase 8 moves its ownership into the explicit composition root.
