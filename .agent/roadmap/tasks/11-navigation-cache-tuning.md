# 11 - Navigation Cache Tuning

## Roadmap Item

Navigation cache tuning: keep a small adjacent-image window hot without retaining stale full-size
image references.

## Goal

The viewer should keep only nearby image asset URLs and preloaded browser images warm, while avoiding
stale full-size image references after navigation or file mutations.

## Current Code Context

- `ImageCanvas` currently uses a local `preloadCache` with a cleanup window of roughly 10 nearby
  images.
- Roadmap task 01 introduces or should introduce `imageAssetCache`.
- `viewerStore` knows `currentIndex`, `images`, and mutation state.

## Implementation Steps

1. If task 01 is not complete, complete it first or include its cache module in this task.
2. Define cache constants in one place:
   - previous images to keep hot: 2
   - next images to keep hot: 3
   - maximum full asset entries: 12
   - debounce before preloading: 120 ms to 180 ms.
3. In `ImageCanvas`, compute a keep set from `images` and `currentIndex`.
4. Preload only the keep window.
5. Call `trimImageAssetCache(keepSet, MAX_FULL_ASSET_ENTRIES)` after preloading.
6. Make mutation invalidation remove stale asset URLs for the mutated path before reloading.
7. Avoid storing `HTMLImageElement` objects in long-lived maps unless needed:
   - if used for browser cache warming, create it and let it be garbage collected.
   - do not keep element references in the cache.
8. Add cancellation or generation checks so slow preload completion for an old folder does not
   repopulate the cache after a new folder opens.
9. When images array changes, trim entries not present in the new folder.

## Acceptance Criteria

- Only a small adjacent window remains in the asset cache after navigation.
- Switching folders removes old folder asset URLs from the warm cache.
- Saving rotation or future crop invalidates stale full-size URL for that path.
- Fast navigation remains smooth.

## Tests

- Add tests for cache trimming behavior in `imageAssetCache.test.ts`.
- Test old generation preloads do not repopulate the cache.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm no `Image` element references are retained without reason.
- Confirm keep-window constants are clear and easy to tune.
- Confirm stale URL invalidation covers file mutations.

