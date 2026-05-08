# 02 - Shared Thumbnail Cache

## Roadmap Item

Shared thumbnail cache: replace per-view base64 thumbnail caches with a shared LRU cache used by both
the thumbnail strip and contact sheet.

## Goal

`ThumbnailStrip` and `ContactSheet` must share one in-memory thumbnail cache and request queue so an
image thumbnail decoded in one view is reused in the other.

## Current Code Context

- `src/components/ThumbnailStrip.tsx` has its own `cacheRef`, queue, in-flight set, and batching.
- `src/components/ContactSheet.tsx` duplicates the same caching and queue logic.
- Both call `getThumbnail(path)` from `src/services/tauriCommands.ts`.

## Implementation Steps

1. Create `src/services/thumbnailCache.ts`.
2. Implement an in-memory LRU cache keyed by file path:
   - value: `dataUrl: string`
   - metadata: `lastAccessedAt`, `inFlightPromise`
   - maximum entries should be configurable; default to 1000.
3. Add exported functions:
   - `getCachedThumbnail(path: string): string | undefined`
   - `loadThumbnail(path: string): Promise<string>`
   - `preloadThumbnails(paths: string[], options?: { concurrency?: number }): void`
   - `evictThumbnailsExcept(keepPaths: Set<string>, maxEntries?: number): void`
   - `clearThumbnailCacheForTests(): void`
4. Ensure `loadThumbnail` deduplicates concurrent requests for the same path.
5. Move queue pumping and concurrency control into the service. Use a default concurrency of 6.
6. Update `ThumbnailStrip`:
   - remove local queue/cache refs
   - render `getCachedThumbnail(image.path)`
   - call `preloadThumbnails(visiblePaths, { concurrency: 4 })`
   - keep only view-specific scroll and virtualization code.
7. Update `ContactSheet` the same way, using `{ concurrency: 6 }`.
8. Preserve the existing requestAnimationFrame batching in components or expose a subscription from
   the cache. The simplest implementation is:
   - service accepts an optional `onLoaded` callback in `preloadThumbnails`
   - component increments its version state from that callback.
9. Add cleanup so callbacks from unmounted components are not called.

## Acceptance Criteria

- Viewing thumbnails in the strip then opening the contact sheet does not re-request the same visible
  thumbnails.
- Contact sheet and strip keep their existing virtualization behavior.
- Concurrent requests for the same path produce one Tauri `get_thumbnail` call.
- Cache eviction is deterministic and keeps visible/nearby thumbnails.

## Tests

- Add `src/services/thumbnailCache.test.ts`.
- Mock `getThumbnail`.
- Test cache hit, in-flight request dedupe, LRU eviction, and callback notification.
- Update component tests only if existing assertions break.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Check that cache state is not stored in React component closures anymore.
- Check that unmounting during thumbnail loads cannot call stale callbacks.
- Check that the service does not leak unbounded promises or paths.

