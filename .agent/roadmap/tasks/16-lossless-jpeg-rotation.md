# 16 - Lossless JPEG Rotation

## Roadmap Item

Lossless JPEG rotation: prefer metadata or lossless transforms when available instead of always
re-encoding pixels.

## Goal

JPEG rotation should avoid generation loss whenever possible. The app should first try a lossless
JPEG path, then fall back to current pixel re-encoding only when necessary.

## Current Code Context

- `save_rotated_image` in `src-tauri/src/commands.rs` decodes and re-saves pixels for JPEG, PNG,
  WebP, and BMP.
- It uses `little_exif` to reset orientation after saving.
- `image` crate re-encoding JPEG is lossy.

## Implementation Steps

1. Research local dependency options before coding:
   - if a reliable Rust crate for lossless JPEG transforms is already available, prefer it.
   - if adding a crate, keep it narrow and document why in PR.
2. Update `save_rotated_image` behavior for JPEG/JPEG only:
   - if rotation is 90/180/270 and dimensions satisfy lossless transform constraints, use lossless
     transform.
   - if lossless transform fails, fall back to current decode/re-encode path with a warning in logs.
3. Consider EXIF orientation-only updates:
   - For a pure orientation metadata change, visual result depends on renderers respecting EXIF.
   - Since LightFrame displays via asset protocol/browser, verify whether browser honors EXIF for
     local JPEGs. If not reliable, prefer pixel-transform lossless path.
4. Preserve or update metadata:
   - final orientation must be normal (`1`) if pixels are transformed.
   - do not leave stale orientation tags.
5. Keep non-JPEG behavior unchanged.
6. Add user-facing error only when both lossless and fallback fail.
7. Add unit tests around helper selection logic even if true lossless transform requires integration
   testing.

## Acceptance Criteria

- JPEG rotation attempts lossless transform before pixel re-encode.
- Non-JPEG rotation behavior remains unchanged.
- EXIF orientation is not left in a double-rotation state.
- If lossless is unavailable or fails, rotation still works through the existing fallback.

## Tests

- Add Rust tests for decision helper:
  - JPEG 90/180/270 selects lossless attempt.
  - PNG selects existing path.
  - unsupported extension rejects as before.
- Add an integration-style Rust test with a temporary JPEG if feasible.
- Run `cargo test`.
- Run `cargo clippy -- -D warnings`.
- Run `cargo fmt -- --check`.

## Reviewer Focus

- Confirm lossless path really avoids JPEG re-encoding when it says it does.
- Confirm fallback path is robust.
- Confirm metadata orientation handling is correct.

