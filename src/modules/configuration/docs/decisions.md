# Configuration support decisions

## Current

- Configuration owns source precedence and atomic document transactions, not product policy. The precedence list and the HOME three-candidate call site live in [operations.md](./operations.md); other documents point there rather than restating the list.
- Each capability owns its fragment schema, defaults, normalization, and update command.
- The existing unversioned persisted JSON shape is preserved during the refactor.
- Generic path reads return opaque JSON values; the consuming capability validates and interprets them.
- The HOME call site passes three candidates: environment, `.env`, and the OS home fallback. It does not pass a persisted-file value, because that file's path is derived from HOME.
- `bootstrap/configuration.ts` is the composition-root owner of the one in-memory document, observed revision, and write path.

## Superseded

- `ConfigStore` as the owner of persistence, capability policy, and manager or navigator side effects is retired. The [operations contract](./operations.md) owns precedence and transaction behavior.

## Implementation-only

- The shared section IO in `bootstrap/configuration.ts` delegates every fragment read and commit to this module. Phase 8 moved that ownership into the explicit composition root; the file above remains the owner.
