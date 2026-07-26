---
description: Complete the tag-driven LightFrame desktop release lifecycle
---

# release

This is the human publication workflow for LightFrame's Windows desktop releases. The GitHub
Action builds packages and creates a draft; a successful workflow run alone is not a published
release.

## Tag and release conventions

- Stable source tags are `v<version>`, for example `v8.7.5`.
- Preview source tags are semver prereleases, for example `v8.8.0-beta.1`.
- `.github/workflows/release.yml` turns either source tag into a draft release tagged
  `app-v<version>` and named `LightFrame v<version>`.
- Preview releases are marked prerelease. Publishing a preview `app-v<version>` release triggers
  `.github/workflows/preview-channel.yml`, which copies its `latest.json` to the fixed
  `app-preview-channel` prerelease.

## Stable or preview release lifecycle

1. Prepare the version in a release change and merge it to `main`. Keep the version synchronized in
   `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`; verify it with
   `pnpm run quality:version`. Start the release from the merged `main` commit.
2. Fetch the merged branch and tags, then create and push the source tag. Substitute the real
   version in the tag and push commands:

   ```bash
   git fetch origin main --tags
   git switch main
   git pull --ff-only origin main
   git tag v8.7.5
   git push origin v8.7.5
   ```

3. Wait for the `Release` workflow for that tag to finish. Do not publish anything while the run is
   pending or failing. A successful run should create the draft `app-v8.7.5` release.

4. Inspect the draft before editing it. Confirm that its release tag is exactly `app-v<version>`,
   that stable/prerelease status matches the source tag, and that the body is no longer treated as
   complete merely because it contains the workflow placeholder:

   ```text
   See the assets to download the installer.
   ```

   The draft must instead contain concise, user-facing Markdown based on the PRs merged into
   `main` since the previous release. Keep the notes focused on notable features, fixes, and
   user-visible changes; omit an unfiltered commit dump and internal-only implementation detail.
   Replace the entire placeholder body in the GitHub release editor. If using the CLI, pass a
   reviewed Markdown file to `gh release edit app-v<version> --notes-file <path>`.

5. Verify the draft assets before publishing. The asset list must include, at minimum:
   - the Windows MSI installer (`*.msi`);
   - the Windows EXE installer (`*.exe`);
   - every corresponding installer signature (`*.sig`); and
   - `latest.json`.

   Confirm that the names and versions match the release, each installer family has its
   corresponding signature, and the files are present and non-empty. Inspect the exact draft and
   asset names with:

   ```bash
   gh release view app-v8.7.5 --json tagName,isDraft,isPrerelease,body,assets,url
   ```

   If the workflow failed, the draft has placeholder-only notes, or either installer family, any
   corresponding signature, or `latest.json` is missing, stop and fix or rerun the release workflow.
   Do not publish a partial release.

6. Publish the verified draft. For a stable release, clear draft and prerelease status; for a
   preview release, keep prerelease status enabled:

   ```bash
   gh release edit app-v<version> --draft=false --prerelease=false
   ```

   The GitHub release page's **Publish release** action is equivalent. For a preview release, use:

   ```bash
   gh release edit app-v<version> --draft=false --prerelease=true
   ```

   Preview verification must show `isDraft=false` and `isPrerelease=true`.

7. Verify the final public release, not just the completed workflow. Confirm the final release URL,
   exact `app-v<version>` tag, stable/prerelease status, both Windows installer families, every
   corresponding signature, and `latest.json` are publicly downloadable:

   ```bash
   gh release view app-v8.7.5 --json url,tagName,isDraft,isPrerelease,assets
   gh release download app-v8.7.5 \
     --pattern '*.msi' \
     --pattern '*.exe' \
     --pattern '*.sig' \
     --pattern 'latest.json' \
     --dir ./release-check
   ```

   Confirm the downloaded set contains both the MSI and EXE installer families, every corresponding
   signature asset, and `latest.json`; the asset list must not be checked by downloading only
   `latest.json`.

   For stable releases, also confirm that the published latest-release updater endpoint resolves to
   the expected `latest.json`. Do not report completion until the final release URL, tag, notes, and
   assets are all verified.

## Completion checklist

- [ ] Version files were synchronized and merged to `main`.
- [ ] The `v<version>` source tag was pushed from merged `main`.
- [ ] The release workflow completed successfully and created `app-v<version>`.
- [ ] Draft notes replace the placeholder and summarize merged PRs in user-facing Markdown.
- [ ] Both MSI and EXE installer families, every corresponding signature, and `latest.json` were
      verified.
- [ ] The draft was published with the correct stable/prerelease status.
- [ ] The final public URL, tag, notes, and assets were verified.
