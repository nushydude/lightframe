# 26 - Priority Cancellable Image Work Scheduler

## Roadmap Item

Priority cancellable image work scheduler: coordinate preview, full image, thumbnail, metadata, and
preload work so current user intent always wins over stale background tasks.

## Goal

Rapid navigation and fast grid scrolling should not be slowed by old thumbnail or preload work. The
app should prioritize the current image, nearby images in the current navigation direction, and
visible grid cells while dropping or deprioritizing work that is no longer useful.

## Current Code Context

- `src/components/ImageCanvas.tsx` tracks request IDs for current image loads and preloads adjacent
  images after a debounce.
- `src/services/thumbnailCache.ts` has a FIFO queue with a global concurrency limit.
- `src/components/ThumbnailStrip.tsx` and `src/components/ContactSheet.tsx` request thumbnail batches
  for visible windows.
- `src/hooks/useImageNavigation.ts` uses load generations to avoid stale folder scan updates.
- Rust commands in `src-tauri/src/commands.rs` run decode and file work on blocking workers but do
  not currently receive cancellation intent.

## Implementation Steps

1. Add an image work scheduler service:
   - work item id.
   - priority.
   - source path.
   - generation token.
   - optional abort signal.
   - queue state exposed for telemetry.
2. Define priority bands:
   - current image preview.
   - current image full-resolution on demand.
   - next/previous images in navigation direction.
   - visible grid or strip thumbnails.
   - background adjacent preloads.
3. Replace thumbnail FIFO behavior with scheduler-backed requests:
   - dedupe same path and metadata token.
   - promote priority when an existing request becomes visible or current.
   - drop queued work for images outside the latest keep window.
4. Integrate image asset preloading:
   - schedule preview and full preloads through the same priority model.
   - keep current request ID and load generation protection.
5. Add cancellation boundaries:
   - queued JavaScript work should be cancellable before invoking Rust.
   - completed Rust responses should be ignored if their generation is stale.
   - if practical, add cooperative cancellation checks to longer Rust loops in later tasks.
6. Add navigation-direction awareness:
   - when repeatedly navigating right, preload further ahead than behind.
   - when direction changes, promote the new leading window.
7. Feed metrics into the performance telemetry overlay if task 24 exists:
   - queue depth.
   - active jobs by priority.
   - dropped stale jobs.

## Acceptance Criteria

- Current image preview requests always outrank background thumbnail and preload work.
- Rapid grid scrolling drops queued thumbnails outside the current keep window.
- Rapid next/previous navigation does not keep loading old adjacent images first.
- Duplicate requests for the same path and metadata token are deduped.
- Scheduler state is testable without React components.

## Tests

- Unit tests for priority ordering.
- Unit tests for dedupe and priority promotion.
- Unit tests for dropping stale queued work.
- Thumbnail cache tests updated to cover scheduler integration.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm the scheduler does not starve lower-priority visible work forever.
- Confirm stale completions cannot overwrite the current image.
- Confirm concurrency is bounded and configurable.
- Confirm cancellation intent is clear even where Rust work cannot yet be interrupted mid-decode.
