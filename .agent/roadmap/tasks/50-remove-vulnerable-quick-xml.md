# 50 - Remove Vulnerable quick-xml 0.37.5

## Priority and Type

- Priority: P0
- Type: dependency security and malicious-file resilience
- Dependencies: none
- Expected branch: `codex/remove-vulnerable-quick-xml`
- Required final gate: `pnpm run ci:local`

## Goal

Remove the shipped `quick-xml 0.37.5` dependency and the corresponding RustSec exceptions without
regressing EXIF preservation for JPEG, PNG, and WebP edit workflows.

The result must make both `RUSTSEC-2026-0194` and `RUSTSEC-2026-0195` inapplicable to the resolved
Cargo graph. Merely moving the ignore list, documenting the risk, or suppressing the audit elsewhere
does not satisfy this task.

## User and Security Outcome

- A crafted local image or embedded XMP payload cannot reach the known quadratic-CPU or unbounded
  namespace-allocation behavior in `quick-xml 0.37.x`.
- Crop, rotation, and metadata-orientation workflows preserve the metadata behavior users already
  receive.
- CI fails again on these advisories instead of carrying a dated exception.

## Current Code Context

- `little_exif = "0.6.23"` in `src-tauri/Cargo.toml` resolves `quick-xml 0.37.5`.
- `quick-xml 0.41.0` also exists through Tauri/plist, but this does not remove the vulnerable copy.
- `restore_normal_orientation` and `overwrite_with_crop_blocking` use `little_exif::Metadata`.
- `.github/workflows/ci.yml` ignores both RustSec advisories with an issue reference and review date.
- PNG metadata rewriting in `little_exif` contains an XMP parser path.

## Required Investigation

Before editing, the implementation agent must:

1. Run:

   ```powershell
   cargo tree --manifest-path src-tauri/Cargo.toml -i quick-xml@0.37.5
   cargo tree --manifest-path src-tauri/Cargo.toml -i quick-xml@0.41.0
   ```

2. Inspect the latest compatible `little_exif` release and its dependency graph. Do not assume a
   semver update is sufficient.
3. Identify every LightFrame call to `little_exif`.
4. Record which metadata behaviors are essential:
   - read orientation before an edit.
   - write normalized orientation after rotation/crop.
   - preserve relevant metadata on supported output formats.
5. Choose the smallest safe remediation:
   - preferred: upgrade `little_exif` to a release using patched `quick-xml`.
   - acceptable: replace only the used metadata behavior with an already present safe crate or a
     narrow internal implementation.
   - last resort: vendor/fork the dependency with a patched `quick-xml`, with provenance and removal
     criteria documented.

## Non-Goals and Constraints

- Do not redesign the edit pipeline.
- Do not remove metadata preservation silently.
- Do not add a blanket Cargo audit exception.
- Do not use `[patch]` to force an API-incompatible `quick-xml` unless the dependent crate is proven
  compatible by tests.
- Do not expand supported metadata formats in this task.
- Treat all image and XMP bytes as untrusted.

## Implementation Requirements

1. Update `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` so `quick-xml 0.37.5` is absent.
2. Adapt LightFrame metadata calls if the selected dependency changes its API.
3. Preserve the current best-effort behavior: a metadata failure may report or log a scoped error,
   but it must not corrupt the edited image or leave a temporary file in place.
4. Add explicit malicious-XMP regression fixtures constructed in tests. Fixtures must cover:
   - a start element with many unique attributes.
   - excessive namespace declarations.
   - malformed/truncated XMP.
   - a valid XMP packet whose non-EXIF content survives the supported metadata operation, when the
     selected library supports that behavior.
5. Bound fixture sizes so tests are deterministic and do not intentionally exhaust CI memory.
6. Remove the two ignores from `.github/workflows/ci.yml`.
7. Update the README dependency-audit paragraph so it no longer claims an active exception.

## Expected Files

- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/src/commands/mod.rs` and/or a new focused metadata module
- `.github/workflows/ci.yml`
- `README.md`
- Rust tests adjacent to the changed metadata code

## Required Tests

- Existing JPEG lossless rotation metadata behavior remains covered.
- Existing crop-overwrite metadata behavior remains covered.
- A PNG containing crafted XMP returns a bounded error or completes safely.
- Malformed metadata never replaces or damages the original file.
- Temporary and backup files are cleaned or recoverable on every tested failure path.
- `cargo tree -i quick-xml@0.37.5` fails to find that package after the change.

## Validation Commands

```powershell
cargo tree --manifest-path src-tauri/Cargo.toml -i quick-xml@0.37.5
cargo test --manifest-path src-tauri/Cargo.toml commands::tests
pnpm run ci:local
```

Run the repository's RustSec audit through the same mechanism used in CI if available locally. If
`cargo audit` is unavailable, record that limitation and rely on the actual GitHub Rust advisory
check after delivery.

## Acceptance Criteria

- `quick-xml 0.37.5` is absent from `Cargo.lock`.
- Neither RustSec advisory is ignored by CI.
- Metadata-preserving edit tests pass for supported formats.
- Crafted XMP tests demonstrate bounded, non-corrupting behavior.
- All local gates pass.
- The PR explains the dependency choice and any residual metadata compatibility differences.

## Reviewer Checklist

- Reject if the vulnerable version remains in the resolved graph.
- Reject if the fix simply disables advisory enforcement.
- Inspect original-file and temporary-file handling for every new metadata error path.
- Confirm tests exercise actual dependency behavior rather than a mocked parser.
- Confirm README and CI claims match the final graph.
