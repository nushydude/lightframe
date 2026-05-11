# 31 - Windows Native Codec Path

## Roadmap Item

Windows native codec path: use Windows imaging capabilities where they improve performance or format
support, especially for thumbnails, dimensions, HEIC/HEIF, and system-codec-dependent formats.

## Goal

LightFrame is Windows-first, so it should take advantage of native Windows image infrastructure when
that gives faster metadata, better thumbnails, or broader codec support than the pure Rust `image`
crate path. The native path should be optional and carefully isolated.

## Current Code Context

- `src-tauri/Cargo.toml` uses the Rust `image` crate with JPEG, PNG, GIF, WebP, BMP, TIFF, and AVIF
  features.
- `SUPPORTED_EXTENSIONS` includes HEIC, HEIF, AVIF, and SVG.
- `get_image_metadata_blocking`, `get_preview_image_blocking`, `get_thumbnail_blocking`, and
  clipboard/edit commands in `src-tauri/src/commands.rs` rely mostly on `image::open` or
  `image::image_dimensions`.
- Task 21 covers graceful format fallbacks for partially supported formats.
- Task 24 should make it possible to compare native and Rust decode paths.

## Implementation Steps

1. Research and choose the narrow Windows API surface:
   - Windows Imaging Component for dimensions and decode where practical.
   - shell thumbnail provider for thumbnails if it is faster and stable.
   - keep the dependency Windows-only.
2. Add a codec capability layer:
   - `rust_image`.
   - `windows_native`.
   - `browser_renderable`.
   - fallback/unsupported.
3. Implement metadata first:
   - dimensions.
   - format label.
   - file size from filesystem metadata.
   - HEIC/HEIF support if Windows codecs are installed.
4. Implement thumbnail generation second:
   - try native thumbnail or decode path.
   - fall back to existing Rust thumbnail generation.
   - preserve disk cache keys based on source metadata and pipeline version.
5. Keep editing commands on existing Rust paths:
   - do not use native codecs for crop/overwrite/rotation until explicitly planned.
   - avoid silently changing save behavior or metadata preservation.
6. Add settings or debug visibility only if useful:
   - a diagnostic field can show which decode path handled the current image.
   - avoid forcing normal users to choose codec engines.
7. Gate platform-specific code cleanly:
   - compile on non-Windows platforms with the existing Rust path.
   - use `cfg(windows)` modules and tests where possible.

## Acceptance Criteria

- On Windows, metadata can use the native path for formats supported by installed system codecs.
- HEIC/HEIF metadata and thumbnails improve when Windows codec support is available.
- Existing Rust decode behavior remains the fallback.
- Non-Windows builds continue to compile.
- Performance telemetry can compare native and Rust paths.

## Tests

- Rust unit tests for codec capability selection.
- Rust tests for fallback behavior when native decode fails.
- Windows-gated tests where native APIs can be exercised reliably.
- Run `cargo test`.
- Run `cargo fmt -- --check`.
- Run `cargo clippy -- -D warnings`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm native code is isolated and platform-gated.
- Confirm native codec failures fall back without breaking the viewer.
- Confirm save/edit commands are not accidentally routed through unsupported native paths.
- Confirm any new dependency is justified by measurable performance or format support wins.
