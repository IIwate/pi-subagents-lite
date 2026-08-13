# Configuration support decisions

## Current

- Configuration owns source precedence and atomic document transactions, not product policy.
- Each capability owns its fragment schema, defaults, normalization, and update command.
- The existing unversioned persisted JSON shape is preserved during the refactor.
- Generic path reads return opaque JSON values; the consuming capability validates and interprets them.

## Superseded

- `ConfigStore` as the owner of persistence, capability policy, and manager or navigator side effects is retired. The [operations contract](./operations.md) owns precedence and transaction behavior.

## Implementation-only

- ConfigStore getters, mutation names, and injected manager/navigator dependencies are not configuration concepts.
- The transitional ConfigStore section IO delegates every read and commit to this module, so there is exactly one in-memory document and one write path while menus migrate to settings pages. It is deleted with ConfigStore.
