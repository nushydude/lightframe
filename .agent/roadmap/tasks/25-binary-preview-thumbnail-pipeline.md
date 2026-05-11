# 25 - Binary Preview/Thumbnail Pipeline

## Roadmap Item

Binary preview/thumbnail pipeline: stop moving generated images through base64 data URLs where a
file-backed or binary delivery path can reduce memory and IPC overhead.

## Goal

Preview and thumbnail delivery should avoid unnecessary base64 expansion and large JavaScript string
retention. The app should prefer cached files, asset URLs, object URLs, or a custom protocol so the
browser can decode image bytes more directly.

## Current Code Context

- `src-tauri/src/commands.rs` returns preview images from `get_preview_image` as base64 data URLs.
- `src-tauri/src/thumbnails.rs` stores thumbnails on disk but returns them to the frontend as base64
  data URLs.
- `src/services/imageAssetCache.ts` stores preview data URLs in memory.
- `src/services/thumbnailCache.ts` stores thumbnail data URLs in memory.
- `src/components/ImageCanvas.tsx`, `src/components/ThumbnailStrip.tsx`, and
  `src/components/ContactSheet.tsx` consume those URLs as `<img src>`.

## Implementation Steps

1. Define a new generated image asset contract:
   - preview request returns a URL plus metadata instead of a data URL.
   - thumbnail request returns a URL plus metadata instead of a data URL.
   - include a version/cache key so stale images are not reused after edits.
2. Store generated previews on disk:
   - key by source path, modified time, size, max dimension, and pipeline version.
   - write atomically through a temporary file.
   - keep JPEG for opaque previews and PNG/WebP only when alpha requires it.
3. Reuse the existing thumbnail disk cache:
   - return an asset URL for the cached thumbnail file.
   - avoid reading the cached JPEG back into Rust just to base64 encode it.
4. Choose the delivery mechanism:
   - prefer Tauri asset protocol URLs if they satisfy cache and permission needs.
   - otherwise add a narrow custom protocol for generated preview and thumbnail assets.
5. Update frontend caches:
   - rename `dataUrl` fields to a more neutral `url`.
   - keep cache invalidation behavior based on source metadata.
   - avoid storing full generated image payloads in JS strings.
6. Preserve fallback behavior:
   - if file-backed preview generation fails, the app can fall back to the existing full asset URL.
   - if a thumbnail fails, the grid/strip should show the existing placeholder behavior.
7. Add migration safety:
   - version the generated cache format.
   - do not attempt to migrate old base64-only memory state.

## Acceptance Criteria

- Preview generation returns a reusable URL rather than a base64 data URL.
- Thumbnail cache hits do not base64 encode cached JPEG bytes.
- Contact sheet and thumbnail strip continue to render correctly.
- Edited images invalidate generated preview and thumbnail URLs.
- Cache files are written atomically and cleaned up by a bounded cache policy.

## Tests

- Rust tests for preview cache key construction and atomic writes.
- Rust tests for thumbnail cache URL response on cache hit and miss.
- Frontend tests for cache invalidation with URL entries.
- Frontend tests for contact sheet and thumbnail strip placeholder fallback.
- Run `cargo test`.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm no source image path is exposed through a less restricted protocol than existing asset
  access already allows.
- Confirm cache keys include modified time and size to avoid stale images.
- Confirm large generated previews are not retained as JavaScript strings.
- Confirm generated cache cleanup cannot delete arbitrary user files.
