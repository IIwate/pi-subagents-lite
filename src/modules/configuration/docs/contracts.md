# Configuration support contracts

## Public boundary

`public.ts` exports serialized document snapshots, fragment transaction requests/results, source-resolution results, and the repository port. It does not export capability policy types.

## Planned schemas

- `ConfigurationDocumentSnapshot` with in-memory revision metadata.
- `ConfigurationFragmentTransaction` and `ConfigurationCommitResult`.
- `ConfigurationSourceRequest` and `ConfigurationSourceResult`.

The persisted JSON remains in its current unversioned shape. Capability modules validate their own fragments before submitting them.

## Port

`ConfigurationDocumentRepository` loads a document and atomically replaces one fragment. It reports persistence failure instead of swallowing it. File handles and temporary paths remain inside the platform implementation.
