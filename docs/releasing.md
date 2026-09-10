# Releasing

[package.json](../package.json) is the version source. Releases use annotated tags named exactly `v<version>` and the [Publish workflow](../.github/workflows/publish.yml), which runs for pushed `v*` tags and publishes through npm Trusted Publishing. Routine releases must not use a local `npm publish` or a long-lived `NPM_TOKEN`.

## Prepare and publish

1. Set the package version and prepare release notes describing final user-visible features and breaking changes. Fold intermediate fixes, tests, and superseded implementations into the feature they completed.
2. Before tagging, confirm that the release commit is on `origin/main`, the working tree is clean, the changelog is approved, and the normal [Test workflow](../.github/workflows/test.yml) passes for that commit.
3. Create and push the annotated tag. Replace `<version>` with the package version:

   ```sh
   git tag -a v<version> -m "v<version>"
   git push origin v<version>
   ```

4. Check the Publish workflow result. It verifies the tag/version match, installs with the lockfile, checks production and test types, runs the full suite, and performs an npm package dry run before publishing.

Never move or force-push a release tag. Rerun a failed workflow only after confirming npm has not published that version; code fixes require a new version and tag.

## Trusted Publisher setup

In npm package settings, authorize GitHub Actions for owner `IIwate`, repository `pi-subagents-lite`, workflow `publish.yml`, and the `npm publish` action. The workflow uses GitHub-hosted runners, `id-token: write`, and a pinned Trusted Publishing-compatible npm CLI. No npm token secret is required.
