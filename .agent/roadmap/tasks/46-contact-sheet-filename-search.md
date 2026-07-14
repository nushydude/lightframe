# 46 - Contact Sheet Filename Search

## Priority and Type

- Priority: P2
- Type: new functionality
- Dependency: task 42; task 35 is recommended first for very large folders

## Goal

Allow users to narrow the contact sheet by filename without changing the loaded folder, persisted
curation filter, sort order, marked paths, or slideshow order.

## Fixed Search Semantics

- Search scope is `ImageFile.file_name` only, including the extension.
- Matching is case-insensitive substring matching after trimming leading/trailing query whitespace.
- Empty query shows every image.
- Search is local to the currently open contact sheet and is not persisted.
- Search results retain the active folder sort order.
- Search is applied after the existing curation filter because `viewerStore.images` is already the
  visible curation-filtered list.
- Search must not call `setImages`, alter `allImages`, or create a new curation filter.
- Closing the contact sheet clears the query naturally with component unmount.

## UI Requirements

1. Add a search input to the contact-sheet header.
2. Accessible label: `Search filenames`.
3. Placeholder: `Search filenames`.
4. Add a clear button while the query is non-empty:
   - accessible label `Clear filename search`.
   - clicking it clears the query and returns focus to the input.
5. `Ctrl+F` while the contact sheet is open must prevent browser find and focus/select the search
   input.
6. Escape behavior:
   - if the search input has a non-empty query, Escape clears the query and keeps the contact sheet
     open.
   - if the query is empty, Escape uses the existing exit-grid behavior.
7. Count display must show `X of Y images` while a query is active. Here X is matching results and Y
   is the curation-filtered `images.length`.
8. Show `No filenames match “query”.` when there are no results. Keep the search input available.

## Index-Preservation Requirement

Do not treat a result's position as its viewer index.

Build a memoized result list equivalent to:

```ts
type ContactSheetSearchResult = {
  image: ImageFile;
  sourceIndex: number;
};
```

Virtualization uses the result-list position. Opening/navigating an image calls `setCurrentIndex`
with `sourceIndex`.

Selection requirements:

- `selectedPaths` stays path-based.
- Ctrl-click toggles the clicked path as today.
- Shift-click selects a contiguous range in the currently displayed result order, not hidden
  non-matching images.
- Changing the query removes selected paths that are no longer displayed. This prevents hidden
  images from being accidentally included in a visible bulk action.
- The active image highlight is shown only when its path is in the result list.

## Virtualization Requirements

- Calculate row count, spacers, and visible slices from `searchResults.length`.
- Thumbnail cache keys still use the original image metadata.
- Changing query resets contact-sheet scroll position to the top.
- Search filtering must be memoized by `[images, normalizedQuery]` and must not run on unrelated
  hover, rating, or scroll updates.

## Files Expected to Change

- `src/components/ContactSheet.tsx`
- `src/components/ContactSheet.test.tsx`
- `src/index.css`
- A small pure helper such as `src/services/contactSheetSearch.ts` plus tests is encouraged.

## Implementation Steps

1. Add a pure helper that returns result records containing both image and source index.
2. Add local query state, normalized query, and input ref.
3. Convert grid virtualization from `images` to search results.
4. Convert click and shift-range logic to distinguish result position from source index.
5. Update the existing window keyboard handler so it ignores ordinary typing in the search input and
   implements the exact Ctrl+F/Escape behavior above.
6. Reset scroll and reconcile selection when the normalized query changes.
7. Add count, clear, empty-result, and focus styles using existing visual tokens.

## Required Tests

- Empty query returns all images in original order.
- Matching is case-insensitive, includes extension, and trims query edges.
- Result records retain correct source indexes.
- Clicking the second result selects its source index, not index 1.
- Shift selection uses displayed result order and excludes hidden images.
- Query changes remove hidden selected paths.
- Ctrl+F focuses search and prevents default.
- Escape clears a non-empty query before exiting grid.
- Count and empty-result copy are correct.
- Virtualized start/end calculations use result count.
- No call to `setImages` occurs during search.

## Acceptance Criteria

- Users can quickly find images by filename in large contact sheets.
- Search never changes underlying folder order or persisted filters.
- Opening a search result always opens the correct source image.
- Hidden search results cannot be accidentally included in a bulk action.
- Existing contact-sheet virtualization remains effective.

## Validation Commands

```powershell
pnpm run test:run -- src/components/ContactSheet.test.tsx src/services/contactSheetSearch.test.ts
pnpm run test:run
pnpm run build
```

If the helper filename differs, substitute its actual test path.

## Non-Goals

- No regex, glob, fuzzy, EXIF, rating, or path search.
- No viewer-wide persistent filter.
- No search across subfolders.
- No file rename UI.
