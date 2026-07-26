# 55 - Constant-Time Contact Sheet Result Lookup

## Priority and Type

- Priority: P2
- Type: render-path performance
- Dependencies: tasks 35 and 46

## Goal

Locate the current image in contact-sheet results without scanning the full result list on every
render.

## Current Evidence

- Task 46 memoizes filename filtering into `searchResults`.
- `src/components/ContactSheet.tsx` still computes `currentResultIndex` with
  `searchResults.findIndex(...)` in the component body.
- Scroll, selection, thumbnail completion, and curation updates can rerender the component without
  changing the search result membership.
- Task 35 provides normalized viewer path indexes, but a filtered result position needs its own
  result-scoped index.

## Required Design

1. Build a normalized path-to-result-index map in the same memoized derivation as `searchResults`.
2. Read `currentResultIndex` from that map using `currentImagePath`.
3. Rebuild the map only when `images` or the normalized filename query changes.
4. Preserve first-match behavior if duplicate normalized paths are encountered and emit only a
   development warning.
5. Keep source indexes from task 46 intact for opening and navigation.

## Acceptance Criteria

- Unrelated scroll, hover, thumbnail, selection, and rating rerenders do not iterate all search
  results to locate the current image.
- Query and image changes rebuild results and indexes together without drift.
- Search, virtualization, focus, selection, and source-index navigation behave unchanged.
- Path normalization matches task 35.

## Required Tests and Validation

- Add pure helper tests for empty, filtered, duplicate, and Windows path-normalization cases.
- Use an instrumented result derivation to prove lookup does not rerun on unrelated rerenders.
- Run `pnpm run test:run -- src/components/ContactSheet.test.tsx src/services/contactSheetSearch.test.ts`.
- Run `pnpm run ci:frontend`.

## Non-Goals

- No search semantics or contact-sheet UI changes.
- No virtualization rewrite.

## Reviewer Checklist

- Confirm the map is memoized with the result list, not rebuilt in render under another name.
- Confirm `sourceIndex` and result index are never conflated.
