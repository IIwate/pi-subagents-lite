# Background result delivery decisions

## Current

- Delivery policy is separate from result persistence and parent wake mechanics.
- A failed automatic wake does not retry itself; a later eligible event provides the next opportunity.

## Superseded

- Configurable next-turn delivery and session-global injection are retired. Durable origin-branch eligibility and the state-machine examples are the current authority.

## Implementation-only

- Result-inbox helper names, debounce constants, and manager refresh calls are not delivery concepts. Bootstrap translates Pi lifecycle into delivery commands; spawn and delivery stay separate functions.
