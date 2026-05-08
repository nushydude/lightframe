# 06 - Large Image Preview Path

## Roadmap Item

Large image preview path: show a fast downscaled preview first, then load full-resolution pixels when
zooming or inspecting detail.

## Goal

Very large images should display quickly using a preview asset, while full-resolution rendering
should be deferred until the user needs detail.

## Current Code Context

- `ImageCanvas` always renders the full Tauri asset URL.
- `get_thumbnail` returns a 160px thumbnail, which is too small for main preview use.
- `get_image_metadata` can read dimensions.
- Zoom mode is stored in `viewerStore`.

## Implementation Steps

1. Add a new Rust command `get_preview_image(file_path, max_dimension)` that:
   - opens the image
   - resizes it to fit within `max_dimension`, for example 2048px
   - encodes as JPEG or PNG as appropriate
   - returns a data URL.
2. Run the preview command through `spawn_blocking` if task 04 is already done, or implement it in a
   helper that can be moved later.
3. Add `getPreviewImage` to `src/services/tauriCommands.ts`.
4. Create or extend `imageAssetCache` with:
   - `getPreviewAsset(path)`
   - `getFullAsset(path)`
5. In `ImageCanvas`, load preview first for images likely to be large:
   - use metadata dimensions if available
   - or load preview first unconditionally, then full image in background for smaller files.
6. Add state:
   - `previewSrc`
   - `fullSrc`
   - `isFullResolutionReady`
7. Render the preview while full resolution is not ready.
8. Trigger full-resolution load immediately when:
   - zoom mode becomes `actual` or `custom`
   - zoom level exceeds 1
   - EXIF/info inspection does not need full pixels, so do not load full only for EXIF.
9. When the full image loads, swap from preview to full without layout shift.
10. Keep rotation transform applied to both preview and full image.

## Acceptance Criteria

- Large images display a downscaled preview before the full asset finishes loading.
- Zooming to actual size or custom zoom loads full-resolution pixels.
- The image frame does not jump when swapping preview to full.
- Small images still load simply and quickly.
- Preview generation errors fall back to current full-image behavior.

## Tests

- Add Rust tests for preview dimension bounds using temporary generated images.
- Add frontend tests for the decision logic if extracted into a helper.
- Run `cargo test` from `src-tauri`.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm preview data URLs are not stored unbounded.
- Confirm full-resolution loading is demand-driven.
- Confirm generated previews do not strip behavior needed for rotation display.

