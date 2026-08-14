# Testing seams

This file is the authority for the repository's public test seams. It is not a migration history.

The primary seam covers most behavior. The other three exist only where the host, UI, or persistence contract itself is the behavior. Tests at these seams assert public results, snapshots, and events with independent expected values. Private methods, internal maps, collaborator call order, and internal-module mocks are not test interfaces.

## Primary seam

The application facade accepts a schema-valid command and returns a schema-valid result plus events: serialized command in, serialized result and events out.

## Host seam

The registered Agent, StopAgent, and AgentStatus callbacks are exercised through a Pi adapter harness. Registration and callback behavior are the contract.

## UI seam

Navigation commands produce a renderer-independent `NavigatorSnapshot`. Child screen and settings snapshots stay renderer-independent; a small Pi TUI contract suite verifies snapshot application.

## Persistence seam

Repository adapters share contract tests for load, save, append, acknowledge, malformed input, and atomic failure.
