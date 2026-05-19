# 32 - Format-Specific Detail Paths

## Roadmap Item

Format-specific detail paths: expand native or regional decode paths beyond JPEG and HEIC/HEIF
previews where libraries make that reliable.

## Goal

LightFrame should keep unsafe full-image decodes blocked for very large files while still offering
high-detail zoom when a format has a reliable regional decode path. The first slice is native
Windows tiled detail for HEIC/HEIF files when the installed Windows codec can decode them.

## Current Code Context

- `src/components/tiledRenderer.ts` currently treats JPEG as the only tiled-rendering format.
- `src-tauri/src/thumbnails.rs` uses `libjpeg-turbo` cropped decode for JPEG tiles.
- `src-tauri/src/native_codecs.rs` already uses Windows Imaging Component for HEIC/HEIF metadata,
  thumbnails, and previews.
- `src/components/imagePreviewStrategy.ts` blocks direct full-resolution browser loads above the
  safety threshold, so large non-JPEG formats stay preview-only today.

## Implementation Steps

1. Extend the codec capability layer with an explicit detail backend.
2. Add a Windows-native region decode helper that copies a bounded source rectangle through WIC and
   encodes it as a JPEG tile.
3. Route `get_image_tile` through the native region path for native-detail formats while preserving
   the existing JPEG tile path.
4. Gate frontend tiled rendering on metadata-confirmed detail support:
   - JPEG stays supported through the Rust/libjpeg path.
   - HEIC/HEIF use tiles only when metadata says Windows native decode succeeded.
   - formats without a regional path remain on the preview safety path.
5. Keep tile failures on the existing safe fallback path.

## Acceptance Criteria

- Large JPEG tiled rendering behaves as before.
- Large HEIC/HEIF files can use tiled detail on Windows when the OS codec is available.
- HEIC/HEIF files without native decode support do not enter tiled mode.
- Large TIFF/PNG/AVIF/SVG files still avoid unsafe direct full-image loads.
- Non-Windows builds continue to compile.

## Tests

- Frontend tests for tiled-renderer format gating.
- Frontend ImageCanvas test for native HEIC tiled detail.
- Rust tests for codec capability selection.
- Windows-gated Rust test for WIC region tile generation.
- Run `pnpm run test:run -- src/components/tiledRenderer.test.ts src/components/ImageCanvas.test.tsx`.
- Run `cargo test --manifest-path src-tauri/Cargo.toml`.

## Reviewer Focus

- Confirm native detail support is metadata-gated, not inferred from extension alone.
- Confirm the Rust tile command validates source dimensions before generating tiles.
- Confirm unsupported formats stay on the preview safety path instead of falling back to risky full
  browser decodes.
- Confirm WIC-specific code remains isolated behind `cfg(windows)`.
