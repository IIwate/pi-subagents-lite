# Configuration support contracts

## Public boundary

`public.ts` currently exports serialized document read contracts and the repository port. Fragment transactions and source-resolution contracts join the same surface when their production paths migrate. It does not export capability policy types.

## Implemented read schemas

- `ConfigurationDocumentSnapshotSchema` defines a JSON document plus revision metadata held outside that document.
- `ReadConfigurationValueCommandSchema` defines a non-empty document path.
- `ReadConfigurationValueResultSchema` defines a found value, a missing path, or a serializable validation/repository failure.

Fragment transaction and source-precedence schemas remain planned for the slices that migrate writes and operational source resolution. The persisted JSON remains in its current unversioned shape. Capability modules validate their own values before using or submitting them.

## Port

`ConfigurationDocumentRepository` currently loads a serialized document snapshot. Its later atomic replacement operation will report persistence failure instead of swallowing it. File handles and temporary paths remain inside the platform implementation.
