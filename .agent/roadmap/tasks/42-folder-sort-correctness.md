# 42 - Folder Sort Correctness

## Priority and Type

- Priority: P0
- Type: bug fix
- Dependencies: none
- Must be completed before: task 43

## Problem

Folder sorting exists, but three behaviors are incorrect:

1. If a user changes from Size, Date Modified, or Random back to Name, the current folder is not
   re-sorted. `useImageNavigation.ts` returns early for `sortOrder === 'name'`.
2. Random order uses `Array.sort(() => Math.random() - 0.5)`. This is not a valid comparator and is
   biased.
3. Date and size sorts do not define tie-breakers, so equal values inherit an unrelated prior order.

## Required Behavior

Keep the existing `sortOrder` setting values in this task: `name`, `date`, `size`, and `random`.
Do not add sort direction or creation date here; task 43 owns those changes.

Deterministic orders must be:

- Name: natural filename ascending, case-insensitive, then absolute path ascending.
- Date: known modified timestamps newest first; missing/invalid timestamps last; ties use the Name
  order above.
- Size: largest byte size first; ties use the Name order above.
- Random: an unbiased Fisher-Yates shuffle. A supplied random-number function must be injectable for
  unit tests; production defaults to `Math.random`.

Every sort change must preserve `currentImagePath` if the same path remains in the folder. The
resulting `currentIndex` must be the selected path's new index.

## Files to Change

- `src/services/imageSorting.ts`
- `src/services/imageSorting.test.ts`
- `src/hooks/useImageNavigation.ts`
- `src/hooks/useImageNavigation.test.ts`
- Change other tests only when required by the corrected behavior.

## Implementation Steps

1. In `imageSorting.ts`, export a testable Fisher-Yates helper. Use a signature equivalent to:
   `shuffleImages(images, random = Math.random): ImageFile[]`.
   - Return a new array.
   - Never mutate the caller's array.
   - Iterate from `length - 1` down to `1`.
   - Choose `j = Math.floor(random() * (i + 1))` and swap indexes `i` and `j`.
2. Replace the random comparator branch in `sortImages` with that helper.
3. Extract or retain one natural-name comparator and use it as the final tie-breaker for Date and
   Size.
4. Parse `modified_at` safely.
   - A null, empty, non-numeric, or non-finite value is “unknown”.
   - Two unknown values are ordered by natural name.
   - A known value always comes before an unknown value in Date order.
5. In the sort-order effect in `useImageNavigation.ts`, remove the Name-specific early return.
   Only return early when there are no source images.
6. Sort from the authoritative unfiltered source (`allImages` when populated, otherwise `images`).
7. Avoid a second `setCurrentIndex` call when `setImages` has already preserved the current path.
   Assert the final state in a test instead of relying on implementation timing.
8. Do not change Settings UI labels, Rust settings schema, folder metadata, or add dependencies.

## Required Tests

Add tests that prove all of these cases:

- Start with `[small-a, large-b]`, sort by Size, then change to Name; final order is Name order.
- Changing sort preserves the selected path and updates its index.
- Date puts valid newest timestamps first and invalid/null timestamps last.
- Equal Date values are resolved by natural filename order.
- Equal Size values are resolved by natural filename order.
- Natural names order `image1`, `image2`, `image10`.
- A deterministic injected random sequence produces the exact expected Fisher-Yates permutation.
- Random sorting does not mutate the input array.
- The random helper does not use `Array.prototype.sort` with a random comparator.

## Acceptance Criteria

- Returning to Name visibly restores natural filename order without reopening or refreshing the
  folder.
- Date and Size order are deterministic for equal or missing values.
- Random order uses Fisher-Yates.
- The current image remains selected by path across every sort change.
- Existing folder open, refresh, watcher, curation-filter, and slideshow tests continue to pass.

## Validation Commands

```powershell
pnpm run test:run -- src/services/imageSorting.test.ts src/hooks/useImageNavigation.test.ts
pnpm run test:run
pnpm run build
```

## Non-Goals

- No ascending/descending setting.
- No creation-date metadata.
- No new visible sort control.
- No background worker or paged catalog.
- No changes to slideshow shuffle.

## Reviewer Checklist

- Confirm there is no `sort(() => Math.random() - 0.5)` pattern.
- Confirm Name is not skipped in the live sort effect.
- Confirm the selected image is preserved by path, not by its old numeric index.
- Confirm sort helpers do not mutate their input.
