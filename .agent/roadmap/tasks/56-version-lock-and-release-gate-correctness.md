# 56 - Version, Lockfile, and Release Gate Correctness

## Priority and Type

- Priority: P1
- Type: release correctness and CI infrastructure
- Dependencies: none
- Expected branch: `codex/version-release-gate-correctness`
- Required final gate: `pnpm run ci:local`

## Goal

Make version metadata reproducible across JavaScript, Cargo, Tauri, updater artifacts, and the
resolved lockfile. Prevent a release tag from producing artifacts unless the exact release commit
has passed all required quality and advisory gates.

## Confirmed Defect

- `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` report 8.7.5.
- The committed root package record in `src-tauri/Cargo.lock` reports 8.7.4.
- Running Cargo rewrites the lockfile, but `quality:version` still passes.
- The release workflow builds on any `v*` tag and does not itself run or depend on the complete CI
  gate for that exact commit.

## Required Version Contract

`package.json` remains the declared source of truth unless the implementation documents and tests a
different single source.

The version check must validate:

- `package.json`.
- `src-tauri/Cargo.toml`.
- root `lightframe` package entry in `src-tauri/Cargo.lock`.
- `src-tauri/tauri.conf.json`.
- release tag format and value when running in a tagged workflow.
- updater/release artifact version where available after build.

The check must distinguish the LightFrame package entry from dependency versions.

## Implementation Steps

1. Extend `scripts/check-version-sync.mjs` to parse Cargo TOML/lock data safely.
2. Add a deterministic update command such as `pnpm run version:set -- <semver>` or extend the
   existing release process.
3. The update command must:
   - validate stable and prerelease semver.
   - update all declared manifests.
   - refresh the Cargo lockfile using Cargo, not text substitution alone.
   - run the version check.
4. Add tests/fixtures for:
   - synchronized stable version.
   - synchronized prerelease.
   - mismatched Cargo.lock root package.
   - a dependency with the same version that must not confuse the parser.
   - malformed and prefixed tags.
5. Add a post-build verification that inspects the produced application/update metadata.
6. Make release workflow execution contingent on:
   - version/tag synchronization.
   - frontend quality.
   - Rust quality.
   - JavaScript and Rust advisory gates.
   - Windows packaged startup smoke for the same commit.
7. Use `workflow_run`, a reusable verified build workflow, or a single release workflow that runs
   the full gates. Document the exact same-SHA guarantee.
8. Ensure draft release creation cannot occur before gates pass.

## Release Behavior

- Stable tags: `vX.Y.Z`.
- Preview tags: `vX.Y.Z-prerelease.N` or existing documented semver prerelease rules.
- Any other `v*` shape fails before build.
- A tag version differing from manifests fails.
- Re-running a failed release must not create conflicting or partially updated public channels.
- Existing stable and preview updater channel behavior remains intact.

## Expected Files

- `scripts/check-version-sync.mjs`
- New version-update/check test fixtures
- `package.json`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `.github/workflows/preview-channel.yml` if required
- README release documentation
- Corrected `src-tauri/Cargo.lock`

## Validation Commands

```powershell
pnpm run quality:version
pnpm run test:run
pnpm run ci:local
pnpm tauri build --no-bundle --ci
```

Where feasible, validate workflow YAML and run the version script against temporary fixture copies
for stable, prerelease, mismatch, and invalid-tag cases.

## Acceptance Criteria

- The committed lockfile root package matches the application version.
- Any future mismatch fails `quality:version`.
- A release tag cannot bypass required checks for its exact SHA.
- Tag and manifest disagreement fails before artifact creation.
- Stable and preview releases retain their intended updater behavior.
- Version update instructions are one command and reproducible.

## Reviewer Checklist

- Confirm the lockfile parser selects the root LightFrame package.
- Trace the same-SHA relationship between CI success and release build.
- Reject reliance on branch-level green status.
- Confirm draft/prerelease and preview-channel behavior after workflow changes.
- Confirm the repository is clean after running the documented version update command.

