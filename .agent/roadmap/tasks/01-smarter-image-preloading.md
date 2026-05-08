# 01 - Smarter Image Preloading

## Roadmap Item

Smarter image preloading: reuse preloaded asset URLs during navigation and only cache-bust after
file-changing operations like saved rotation or crop.

## Goal

Navigation should use already prepared asset URLs instead of generating a new cache-busted URL on
every image change. Cache busting must happen only after disk writes that change image bytes.

## Current Code Context

- `src/components/ImageCanvas.tsx` owns a local `preloadCache` and appends `?v=${cacheBuster}`.
- `src/state/viewerStore.ts` changes `cacheBuster` in `setCurrentImage` and `setCurrentIndex`, which
  forces every normal navigation to look like a file mutation.
- `saveRotation` is the current file-changing operation. Crop tasks will add more later.
- `src/hooks/useImageNavigation.ts` navigates through store actions.

## Implementation Steps

1. Create a dedicated image asset cache module, for example `src/services/imageAssetCache.ts`.
2. Store entries by absolute file path. Each entry should include:
   - `url: string`
   - `version: number`
   - `lastUsedAt: number`
3. Add functions:
   - `getImageAssetUrl(path: string): Promise<string>`
   - `preloadImageAsset(path: string): Promise<void>`
   - `invalidateImageAsset(path: string): void`
   - `trimImageAssetCache(keepPaths: Set<string>, maxEntries: number): void`
4. Move `convertFileSrc` usage into the cache module. Do not append a cache-buster for normal
   navigation.
5. When invalidating an image after a disk mutation, append a version query parameter for that path
   only. The version can be `Date.now()` stored in the cache module.
6. Update `ImageCanvas` to call `getImageAssetUrl(currentImagePath)` and to call
   `preloadImageAsset` for adjacent images.
7. Remove the `cacheBuster: Date.now()` updates from `setCurrentImage` and `setCurrentIndex`.
8. Keep a narrow mutation signal in the store:
   - Either keep `cacheBuster` but increment it only after mutation, or replace it with
     `mutatedImagePathVersion`.
   - The simpler implementation is to keep `cacheBuster` and update it only in `saveRotation`.
9. In `saveRotation`, after `saveRotatedImage` succeeds, call `invalidateImageAsset(currentImagePath)`
   before updating the store.
10. Make sure future crop tasks can call the same invalidation function.

## Acceptance Criteria

- Navigating next and previous does not append a fresh timestamp to the image URL.
- A preloaded adjacent image is reused when it becomes current.
- Saving rotation invalidates only the current image and reloads it with a fresh URL.
- Distant preloaded entries are trimmed so the cache cannot grow without bound.
- Existing zoom, pan, rotation preview, and slideshow behavior still work.

## Tests

- Add unit tests for `imageAssetCache` with `convertFileSrc` mocked.
- Assert two reads of the same path return the same URL before invalidation.
- Assert `invalidateImageAsset(path)` changes only that path's URL.
- Update `src/state/viewerStore.test.ts` so navigation no longer expects `cacheBuster` movement.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Verify cache invalidation happens after disk writes and not during normal navigation.
- Verify no stale rotated image can remain visible after `saveRotation`.
- Verify cache trimming keeps adjacent paths and removes distant paths deterministically.

