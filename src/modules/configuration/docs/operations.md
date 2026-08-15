# Configuration operations

## Source precedence

This document is the owner of the operational source-precedence list.

For operational settings only, the resolver uses:

1. environment variables;
2. `.env` values;
3. a configured file value when the setting can have one;
4. defaults owned by the capability that consumes the setting.

Interactive product policies such as Model access and Thinking access are not silently overridden by environment values: the document facade has no environment port, and only the composition root resolves operational values.

Physical file locations are governed by REQ-CONFIG-002: they derive from the Pi agent directory and Pi's project config directory name, with no former-location fallback and no automatic migration.

The home directory is the one operational setting today and it serves exactly one consumer: the user-level `.agents/skills` skill root. Its composition-root call site passes three candidates — environment, `.env`, and the OS home fallback — and does not pass a config-file value: nothing persisted derives from HOME anymore, and the resolver predates the document it once located. A set-but-empty variable counts as absent so it cannot blank out a usable lower-precedence source. Every persisted extension file location derives from the Pi agent directory instead; see [Canonical Pi host resources](../../../../docs/architecture/decisions.md).

## Physical format

The refactor preserves the current unversioned `modelRouting`, `agent`, and `concurrency` sections. A `revision` is runtime transaction metadata and is not written to disk. No dual-format reader or migration layer is introduced.

The module owns the in-memory document, loaded once from the file repository at composition time. The repository reports one of three states — `absent` (strictly a missing file), `loaded`, or `malformed` with a message for any other read failure. Both `absent` and `malformed` read as an empty document, matching the approved startup behavior; the status additionally governs writes under the facade's `malformedPolicy`: `reset-on-commit` (global document) overwrites a malformed file on the next commit as before, while `read-only` (project documents) refuses commits with `document-malformed` and never rewrites a file it could not read.

## Transaction boundary

The owning capability validates and normalizes its proposed fragment, then submits one `commit-fragment` with the revision it last observed. The commit merges only the submitted assignments into the named section and deletes only the named removals: keys it does not mention — including retired keys and keys owned by other capabilities — keep their JSON value, because this build cannot distinguish junk from data a newer capability owns. Removing the last key keeps an empty section object. The repository re-serializes the whole document, so JSON semantics are preserved but original whitespace or byte layout is not. A stale `expectedRevision` is rejected as `revision-conflict` before anything is written.

## Failure boundary

Read failure uses the approved current startup behavior. Write failure returns an explicit failure to the initiating settings/application use case. The old fragment remains the effective in-memory value and no manager, navigator, runtime, or prompt consumer is synchronized with an unpersisted candidate.

## Replacement condition

Replacing JSON-file storage changes one `ConfigurationDocumentRepository` platform implementation. Product modules do not change.
