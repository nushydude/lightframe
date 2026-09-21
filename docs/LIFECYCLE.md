# Lifecycle and release policy

## Status

LightFrame is an active public product. The repository is Windows-first, uses Tauri/React/Rust, and has an established CI and release workflow.

## Development lifecycle

- Use the repository's isolated task/worktree workflow from `AGENTS.md`.
- Preserve unrelated changes and never reset a dirty source checkout.
- Keep frontend, Rust, packaged-startup, dependency-audit, and release checks separate and visible.
- Treat generated development and cache artifacts, runtime state, and user curation data as
  local-only. Release artifacts intended for publication or retention are explicitly exempt and
  follow the release archival policy below.

## Release gates

Use the commands documented in `README.md` and `AGENTS.md`, with `pnpm run ci:local` as the broad
local gate. Currently configured release checks validate version consistency, packaged startup,
dependency advisories, and updater metadata. Checksums, SBOM, provenance, and the appropriate
signing requirements are target release-integrity requirements tracked by roadmap tasks
`.agent/roadmap/tasks/56-version-lock-and-release-gate-correctness.md` and
`.agent/roadmap/tasks/57-release-supply-chain-and-windows-trust.md`; they are not all currently
implemented mandatory gates.

A release is not complete merely because a build succeeds: the exact tagged SHA and generated artifacts must be verified by CI and the release evidence reviewed before publication.

## Data and archival

Do not commit user image collections, generated caches, telemetry snapshots, `.agent/runtime` state, or credentials. Retain old releases through GitHub releases and tags; use worktrees for temporary implementation tasks rather than sibling source copies.
