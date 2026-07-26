# 53 - Change-Proportional Folder Reconciliation

## Priority and Type

- Priority: P1
- Type: large-folder performance
- Dependencies: follow-up to tasks 29 and 35

## Goal

Apply a small watcher event batch with work proportional to the changed paths, without rebuilding
and sorting the entire folder catalog.

## Current Evidence

- `reconcileFolderWatcherPayload` in `src/services/folderWatcherReconciliation.ts` receives an
  incremental payload, but `applyFolderWatcherChanges` first creates a full `Map` from `images`.
- `reconcileDraft` materializes every map value, calls `sortImages` for the full catalog, scans for
  the preferred path, and returns a replacement array.
- `useImageNavigation::handleFolderWatcherPayload` then sends that full array through
  `applyFolderImages`.
- Task 29 introduced event classification and coalescing; task 35 introduced revision-scoped path
  indexes. This issue is the remaining change-proportional reconciliation step.

## Required Design

1. Reuse the store's normalized path index rather than rebuilding a full membership map.
2. For name/date/size sorts, remove, replace, or binary-insert only changed records while preserving
   stable tie-breaking and sort direction.
3. For random order, preserve unchanged positions and define deterministic placement for additions.
4. Batch all changes into one store transaction and one image-list revision.
5. Preserve current-path selection and cache invalidation without additional full-list scans.
6. Keep the existing threshold/full-refresh fallback for ambiguous or oversized event batches.

## Acceptance Criteria

- A one-file add, remove, modify, or rename does not call the full `sortImages` path or rebuild a
  catalog-sized membership map.
- One watcher payload produces at most one list transaction and revision increment.
- Current selection, curation filtering, random order, and invalidation remain correct.
- Unsupported and ambiguous events still use the safe full-refresh fallback.

## Required Tests and Validation

- Add deterministic tests using an instrumented comparator/index that assert operations are bounded
  by changed paths plus ordered insertion lookup, not total-folder remapping.
- Cover every sort field/direction, equal-key ties, multi-change batches, current-image rename/delete,
  and random additions.
- Retain tests for the `MAX_INCREMENTAL_FOLDER_WATCHER_CHANGES` fallback.
- Run watcher, viewer-store, and navigation tests.
- Run `pnpm run ci:frontend`.

## Non-Goals

- No new native watcher implementation.
- No removal of manual or fallback full refresh.

## Reviewer Checklist

- Confirm the hot path does not hide an O(n) map, set, sort, or preferred-path scan.
- Confirm array and task 35 indexes update atomically.
- Confirm stable ordering matches a full sort for the same final contents.
