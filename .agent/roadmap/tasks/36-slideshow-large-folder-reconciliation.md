# 36 - Slideshow Large-Folder Reconciliation

## Priority and Type

- Priority: P1
- Type: slideshow performance
- Dependency: task 35

## Goal

Normal slideshow renders and slide advances must not map or join every image path. Rebuilding shuffle
state after an actual folder-list change must remain O(n), never O(n²).

## Confirmed Cost

`useRef(images.map((image) => image.path))` evaluates the `images.map` expression on every render,
even though React ignores the initializer after the first render. Current-index changes therefore do
avoidable O(n) work for large folders.

## Required Design

- Consume `imageListRevision` and `visibleImageIndexByPath` from task 35.
- Keep one `previousImagePathsRef` snapshot, but update it only when `imageListRevision` changes or a
  new shuffled slideshow starts.
- Do not create an image-path signature string.
- Do not depend on `currentIndex` in the timer effect merely to refresh a closure. Maintain the
  existing `currentIndexRef` instead.
- Shuffle reconciliation may allocate one next-path array, one Set, and one Map per actual list
  revision. It must not call `indexOf` inside a loop.

## Implementation Steps

1. Replace the eager `useRef(images.map(...))` initializer with `useRef<string[]>([])`.
2. Subscribe narrowly to `imageListRevision` from viewerStore.
3. Initialize path snapshot when starting Shuffle and mark the revision that snapshot represents.
4. Run reconciliation only when all are true:
   - slideshow is active.
   - shuffle is enabled.
   - at least two visible images exist.
   - current `imageListRevision` differs from the reconciled revision.
5. During reconciliation:
   - build `nextImagePaths` once.
   - build `nextPathSet` once.
   - use `visibleImageIndexByPath` from the store rather than constructing another index map.
   - preserve current image at the cursor.
   - retain already-seen status for paths still present.
   - remove missing paths.
   - shuffle only newly added remaining paths.
6. After reconciliation, store paths/revision refs atomically before the next timer tick can use
   them.
7. Remove `currentIndex` from timer-effect dependencies if tests prove the ref supplies the current
   value. Keep interval, active, paused, image count, and effective advance callback dependencies.

## Required Semantics

- Starting image is not replayed before all other cycle images in a non-looping shuffled slideshow.
- Current image remains current after a folder change.
- Added images enter the unvisited portion.
- Removed images disappear from order.
- Direction changes preserve the existing reverse/forward tests.
- Loop begins a fresh complete cycle only after the current cycle is exhausted.

## Required Tests

- Instrument a path getter or helper call count to prove current-index-only rerenders do not map the
  full list. Do not use wall-clock timing.
- Revision change triggers exactly one reconciliation.
- Metadata-only update without list revision does not rebuild shuffle order.
- Add, remove, reorder, filter, and unfilter preserve the required semantics.
- A synthetic 10,000-image reconciliation performs no `indexOf` path lookup inside iteration.
- All existing forward/reverse, loop, pause, fullscreen, and mid-cycle setting tests pass.

## Acceptance Criteria

- Slide advance is O(1) with respect to folder size, excluding image loading itself.
- Unrelated renders do not enumerate image paths.
- Actual list reconciliation is O(n).
- Visible behavior is unchanged.

## Validation Commands

```powershell
pnpm run test:run -- src/hooks/useSlideshow.test.ts src/state/viewerStore.test.ts
pnpm run test:run
pnpm run build
```

## Non-Goals

- No UI changes.
- No slideshow option changes.
- No folder catalog paging.
- No alternate random-number generator.
