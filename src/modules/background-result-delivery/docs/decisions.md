# Background result delivery decisions

## Current

- Delivery policy is separate from result persistence and parent wake mechanics.
- A failed automatic wake does not retry itself; a later eligible event provides the next opportunity.

## Superseded

- Removed delivery modes and superseded recovery windows remain historical scenarios only. See [refactoring-history-audit.md](../../../../docs/refactoring-history-audit.md) until Phase 0 transfers their classification.

## Implementation-only

- `SpawnCoordinator`, result-inbox helper names, debounce constants, and manager refresh calls are not delivery concepts.
