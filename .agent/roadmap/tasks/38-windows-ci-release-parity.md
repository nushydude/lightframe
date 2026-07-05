# 38 - Windows CI Release Parity

## Roadmap Item

Audit follow-up: exercise Windows-only code paths before release tags.

## Goal

LightFrame is Windows-first and releases Windows packages. Pull requests should catch Windows-only
Rust, codec, shortcut, and Tauri packaging failures before a tag-driven release job.

## Current Code Context

- `.github/workflows/ci.yml` runs frontend quality and Rust checks on Ubuntu.
- `.github/workflows/release.yml` builds Windows packages on `windows-2025`.
- Windows-only modules include native codecs and shortcut repair.
- Several Rust tests are `cfg(windows)` and only run on Windows.

## Implementation Steps

1. Add a Windows CI job for pull requests and pushes to `main`.
2. Keep the job focused enough to be reliable:
   - install Node and pnpm versions consistent with the repo.
   - install Rust stable with clippy and rustfmt.
   - run Windows Rust tests and clippy.
   - run frontend build if the incremental cost is acceptable.
3. Add a Tauri build smoke test when feasible:
   - prefer a non-publishing build.
   - skip installer signing unless release secrets are available.
4. Use caching for cargo and pnpm where appropriate.
5. Keep release workflow behavior unchanged unless a shared setup action is introduced.

## Acceptance Criteria

- Pull requests run at least one Windows job that exercises `cargo test` for Windows-only tests.
- Windows clippy runs with `-D warnings`.
- The workflow is documented enough that failures are actionable.
- Release workflow still builds draft Windows releases from tags.

## Tests

- Validate workflow YAML syntax.
- If possible, run the relevant commands locally on Windows:
  - `pnpm install --frozen-lockfile`
  - `pnpm run build`
  - `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
  - `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
  - `cargo test --manifest-path src-tauri/Cargo.toml`
- Confirm the PR pipeline runs the new Windows job.

## Reviewer Focus

- Confirm the Windows job catches meaningful Windows-specific failures.
- Confirm CI runtime is reasonable and does not duplicate expensive work unnecessarily.
- Confirm pnpm, Node, and Rust versions match project documentation.
- Confirm release signing secrets are not required for PR validation.
