# Configuration operations

## Source precedence

For operational settings only, the resolver uses:

1. environment variables;
2. `.env` values;
3. the persisted `subagents-lite.json` file;
4. defaults owned by the capability that consumes the setting.

Interactive product policies such as Model access and Thinking access are not silently overridden by environment values.

## Physical format

The refactor preserves the current unversioned `modelRouting`, `agent`, and `concurrency` sections. A `revision` is runtime transaction metadata and is not written to disk. No dual-format reader or migration layer is introduced.

The module owns the in-memory document, loaded once from the file repository at composition time. A missing or malformed file resolves to an empty document, matching the approved startup behavior.

## Transaction boundary

The owning capability validates and normalizes its proposed fragment, then submits one `commit-fragment` with the revision it last observed. The commit merges only the submitted assignments into the named section: keys it does not mention — including retired keys and keys owned by other capabilities — stay byte-identical on disk, because this build cannot distinguish junk from data a newer capability owns. A stale `expectedRevision` is rejected as `revision-conflict` before anything is written.

## Failure boundary

Read failure uses the approved current startup behavior. Write failure returns an explicit failure to the initiating settings/application use case. The old fragment remains the effective in-memory value and no manager, navigator, runtime, or prompt consumer is synchronized with an unpersisted candidate.

## Replacement condition

Replacing JSON-file storage changes one `ConfigurationDocumentRepository` platform implementation. Product modules do not change.
