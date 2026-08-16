# Configuration support contracts

## Public boundary

`public.ts` exports serialized document read, fragment transaction, and reload contracts plus the repository port. It does not export capability policy types: capability modules validate their own values before using or submitting them.

## Implemented schemas

- `ConfigurationDocumentSnapshotSchema` defines a JSON document plus revision metadata held outside that document.
- `ReadConfigurationValueCommandSchema` defines a non-empty document path; `ReadConfigurationValueResultSchema` reports a found value, a missing path, or a serializable failure.
- `ConfigurationDocumentStatusSchema` (`absent | loaded | malformed`) is runtime document metadata, never persisted. `ConfigurationDocumentLoadResultSchema` is the repository load contract: `absent` is strictly a missing file, and every other read failure is `malformed` with a presentable message.
- `CommitConfigurationFragmentCommandSchema` submits one section's assignments — and optionally `removals`, which delete named section keys (an emptied section object is kept) — together with the `expectedRevision` the caller last observed. A key in both assignments and removals is `invalid-command`. `CommitConfigurationFragmentResultSchema` returns the next revision or an explicit refusal. `ConfigurationCommitFailureCodeSchema` names the save-refusal codes `persistence-failure`, `revision-conflict`, and `document-malformed`; settings embeds it rather than restating the literals.
- `ReloadConfigurationCommandSchema` re-reads the persisted document; `ReloadConfigurationSuccessSchema` reports the next revision and the document status.
- The facade takes a per-document `malformedPolicy` chosen by the composition root; the two policies and their write behavior are owned by [operations.md](./operations.md).
- `ConfigurationResultSchema` is the aggregate outbound contract for `execute()`; every success and failure is checked against it before callers see the result.

The persisted JSON remains in its current unversioned shape; the revision is runtime transaction metadata only.

- `OperationalValueCandidatesSchema` carries the already-read source values for one operational setting; `resolveOperationalValue` applies the fixed environment > `.env` > configured > fallback order. The HOME call site omits `configured` and passes only environment, `.env`, and fallback. Interactive product policies never pass through this contract.

## Ports

- `ConfigurationDocumentRepository` loads the serialized document and atomically replaces it. `persist` throws on failure instead of swallowing it, so the application layer can keep the prior snapshot effective and report `persistence-failure` to the caller. File handles and temporary paths remain inside the platform implementation.
- `EnvironmentSource` exposes the process environment and the composition-root-selected `.env` file as separate raw sources, keeping the precedence decision in the configuration core.
