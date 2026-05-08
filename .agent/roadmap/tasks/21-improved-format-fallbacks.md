# 21 - Improved Format Fallbacks

## Roadmap Item

Improved format fallbacks: better thumbnail and metadata behavior for HEIC, AVIF, SVG, and other
system-codec-dependent formats.

## Goal

Unsupported or partially supported formats should degrade gracefully with clear thumbnails, metadata,
and user guidance instead of noisy errors or blank placeholders.

## Current Code Context

- `SUPPORTED_EXTENSIONS` includes HEIC, HEIF, AVIF, and SVG.
- `image` crate features include AVIF but not HEIC/HEIF decoding.
- `get_thumbnail` uses `image::open`, which may fail for HEIC/HEIF/SVG.
- Settings panel already contains HEIF/HEVC extension links for Windows.
- Browser/Tauri asset rendering may display formats Rust cannot decode.

## Implementation Steps

1. Define format capability categories in Rust:
   - browser_renderable
   - rust_decode_supported
   - metadata_supported
   - thumbnail_supported
2. Add command `get_format_support(file_path)` or include fallback info in metadata responses.
3. Update `get_thumbnail`:
   - for SVG, generate a simple deterministic placeholder thumbnail with SVG label or use browser
     rendering path if available.
   - for HEIC/HEIF unsupported decode, return a structured error code or placeholder data URL.
   - for AVIF, keep current decode path but handle errors clearly.
4. Prefer returning a placeholder thumbnail data URL over throwing for known unsupported decode
   formats, so grids remain visually stable.
5. Update `get_image_metadata`:
   - use file size and extension even when dimensions fail.
   - return `width: null`, `height: null`, and `format` rather than failing.
6. Update frontend `ThumbnailStrip` and `ContactSheet`:
   - render fallback thumbnails with format labels.
   - avoid repeated retry loops for known unsupported thumbnail formats.
7. Update `ExifPanel` if needed:
   - show "No metadata available" without treating known unsupported formats as exceptional.
8. Keep SettingsPanel format support guidance but consider linking fallback state to the current file
   in the info panel.

## Acceptance Criteria

- HEIC/HEIF files in a folder do not cause repeated thumbnail error logs.
- SVG files get a useful placeholder thumbnail or rendered thumbnail.
- AVIF failures show graceful fallback.
- Metadata panel still shows extension and file size when dimensions cannot be read.
- Contact sheet and strip remain stable with mixed-format folders.

## Tests

- Rust tests for metadata fallback with fake files/extensions.
- Rust tests for placeholder thumbnail generation for unsupported formats.
- Frontend tests for thumbnail cache handling known fallback data URLs.
- Run `cargo test`.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm fallback formats do not enter infinite retry loops.
- Confirm placeholders are visually useful and accessible.
- Confirm real decode errors for supported formats are still debuggable.

