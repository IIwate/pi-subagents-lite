# Configuration support decisions

## Current

- Configuration owns source precedence and atomic document transactions, not product policy.
- Each capability owns its fragment schema, defaults, normalization, and update command.
- The existing unversioned persisted JSON shape is preserved during the refactor.
- Generic path reads return opaque JSON values; the consuming capability validates and interprets them.

## Superseded

- `ConfigStore` ownership of persistence, policy mutation, and manager/navigator side effects is historical evidence in [refactoring-history-audit.md](../../../../docs/refactoring-history-audit.md).

## Implementation-only

- ConfigStore getters, mutation names, and injected manager/navigator dependencies are not configuration concepts.
- The Phase 1 ConfigStore snapshot repository is read-only migration wiring. It does not become the final persistence adapter or a second write path.
