# Configuration support contracts

## Public boundary

`public.ts` exports serialized document read, fragment transaction, and reload contracts plus the repository port. It does not export capability policy types: capability modules validate their own values before using or submitting them.

## Implemented schemas

- `ConfigurationDocumentSnapshotSchema` defines a JSON document plus revision metadata held outside that document.
- `ReadConfigurationValueCommandSchema` defines a non-empty document path; `ReadConfigurationValueResultSchema` reports a found value, a missing path, or a serializable failure.
- `CommitConfigurationFragmentCommandSchema` submits one section's assignments together with the `expectedRevision` the caller last observed. `CommitConfigurationFragmentResultSchema` returns the next revision or an explicit `revision-conflict`/`persistence-failure`.
- `ReloadConfigurationCommandSchema` re-reads the persisted document and advances the revision.

The persisted JSON remains in its current unversioned shape; the revision is runtime transaction metadata only. Source-precedence contracts join this surface when operational source resolution migrates.

## Port

`ConfigurationDocumentRepository` loads the serialized document and atomically replaces it. `persist` throws on failure instead of swallowing it, so the application layer can keep the prior snapshot effective and report `persistence-failure` to the caller. File handles and temporary paths remain inside the platform implementation.
