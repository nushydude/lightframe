# 30 - Large Image Tiled Renderer

## Roadmap Item

Large image tiled renderer: use a tile-based viewport for very large images so zooming and panning
do not require decoding and drawing the whole image at once.

## Goal

Extremely large images should remain usable. Fit-to-screen can keep the current preview-first path,
but deep zoom and pan should load only the visible region and nearby tiles. GPU acceleration should
be considered here only after telemetry proves the normal `<img>` path is the bottleneck.

## Current Code Context

- `src/components/ImageCanvas.tsx` currently renders the active image with a DOM `<img>`.
- `src/components/imagePreviewStrategy.ts` decides when to load full-resolution pixels.
- `src-tauri/src/commands.rs` generates downscaled previews by decoding full images with the `image`
  crate.
- `src/services/imageAssetCache.ts` stores preview and full asset references.
- Task 24 should provide timings that identify large-image pain points.
- Task 25 may provide a file-backed preview delivery path that can be reused for tiles.

## Implementation Steps

1. Define large-image thresholds:
   - pixel count threshold.
   - dimension threshold.
   - optional file size threshold.
   - use telemetry from task 24 to tune defaults.
2. Add tile generation command:
   - request tile by source path, zoom level, tile x/y, tile size, source metadata token.
   - write generated tiles to a bounded disk cache.
   - return tile URLs rather than base64 payloads.
3. Start with a 2D tile viewport:
   - render visible tiles in a positioned layer.
   - keep current zoom and pan controls.
   - preserve fit/fill behavior with the existing preview path.
4. Add progressive levels:
   - low-resolution preview first.
   - then tiles for the current zoom level.
   - preload neighboring tiles around the viewport.
5. Evaluate GPU rendering only after the tile path works:
   - use Canvas 2D first if it is enough.
   - consider WebGL or WebGPU for tile compositing if panning, transforms, or color work need it.
   - feature-detect and keep a fallback path.
6. Keep scope narrow:
   - no editing through the tiled renderer in this first task.
   - disable crop overlay for tiled mode unless it can be implemented safely.
   - keep standard images on the existing `<img>` path.

## Acceptance Criteria

- Images above the large-image threshold can be viewed and panned without loading the full decoded
  image into the DOM path first.
- Fit-to-screen still shows a fast preview.
- Zooming into a large image loads visible tiles progressively.
- Tile cache is keyed by source path, size, modified time, zoom level, and tile coordinates.
- Non-large images continue using the current renderer.

## Tests

- Rust tests for tile cache key construction and bounds validation.
- Rust tests for rejecting out-of-bounds tile requests.
- Frontend tests for choosing tiled vs standard renderer by metadata.
- Component tests for visible tile coordinate calculation.
- Run `cargo test`.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm this path is only used for images that benefit from it.
- Confirm tile cache cleanup is bounded and cannot delete arbitrary files.
- Confirm zoom and pan behavior remains predictable.
- Confirm GPU code, if added, is feature-detected and has a fallback.
