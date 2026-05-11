# 27 - Byte-Budgeted Memory Governor

## Roadmap Item

Byte-budgeted memory governor: manage preview, full image, and thumbnail caches by estimated memory
cost instead of entry count alone.

## Goal

LightFrame should stay responsive in folders with huge images and long sessions. Cache behavior
should be governed by memory budget, image dimensions, and user mode rather than only by item count.

## Current Code Context

- `src/services/imageAssetCache.ts` limits preview cache entries with `MAX_PREVIEW_CACHE_ENTRIES`.
- `src/services/thumbnailCache.ts` limits thumbnails by entry count.
- `src-tauri/src/thumbnails.rs` limits disk thumbnail cache by entry count and byte count.
- `src/components/ImageCanvas.tsx` trims full and preview image cache entries around the navigation
  hot window.
- Settings in `src/types/settings.ts` and `src/components/SettingsPanel.tsx` can host user-facing
  performance modes if needed.

## Implementation Steps

1. Add a memory accounting model:
   - estimate decoded image cost as `width * height * 4`.
   - estimate preview and thumbnail URL/object cost separately.
   - track unknown sizes conservatively.
2. Replace or augment entry-count limits:
   - full image asset hot window remains count based.
   - preview cache gets a byte budget.
   - thumbnail memory cache gets a byte budget.
3. Add performance modes:
   - `fast`: larger memory budget and more adjacent preloading.
   - `balanced`: current default behavior with byte limits.
   - `lowMemory`: smaller preview/thumbnail caches and reduced preloading.
4. Add settings plumbing:
   - frontend settings type.
   - Rust settings serialization.
   - settings UI control.
   - defaults that preserve current behavior.
5. Add cache eviction policy:
   - prefer keeping current image, adjacent images, and visible thumbnails.
   - evict least-recently-used non-kept entries first.
   - expose budget usage to telemetry if task 24 exists.
6. Keep disk cache separate:
   - do not shrink the disk thumbnail cache just because memory mode is low.
   - only add disk budget settings if a later task needs them.

## Acceptance Criteria

- Preview and thumbnail memory caches respect configured byte budgets.
- Current image and visible thumbnails are not evicted while still needed.
- Users can choose Fast, Balanced, or Low Memory mode.
- Default behavior remains close to the current app experience.
- Telemetry or debug output can show approximate cache memory usage.

## Tests

- Unit tests for memory estimate helpers.
- Unit tests for budget-based eviction.
- Settings conversion tests for the new performance mode.
- Frontend cache tests for keep-path protection under byte pressure.
- Run `pnpm test -- --run`.
- Run `pnpm build`.
- Run `cargo test` if Rust settings are changed.

## Reviewer Focus

- Confirm cache budgets use estimates clearly and do not pretend to be exact process memory.
- Confirm low memory mode does not make navigation feel broken.
- Confirm eviction cannot remove current image resources mid-render.
- Confirm settings migration preserves existing user settings.
