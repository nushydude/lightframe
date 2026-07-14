# 35 - Revision-Scoped Viewer Path Indexes

## Priority and Type

- Priority: P1
- Type: large-folder performance
- Dependencies: none

## Goal

Remove repeated linear path searches and repeated full-list Set/Map construction from common viewer
operations. This task is the frontend indexing foundation only.

## Explicit Scope Decision

Do not add paging, SQLite, new Rust commands, background hydration, or a replacement catalog object
in this task. The persistent Rust folder index continues to return full `ImageFile[]` arrays.

## Current Problems

- `viewerStore` owns `allImages` and curation-filtered `images` arrays but no synchronized path
  lookup.
- Selection preservation, filter reconciliation, compare state, watcher reconciliation, slideshow,
  and projector synchronization perform repeated `findIndex`, `map`, or `new Set(images.map(...))`
  work.
- Contact sheet and thumbnail strip virtualize DOM rendering, but path lookup remains O(n).

## Required State

Add to `ViewerState`:

```ts
allImageIndexByPath: ReadonlyMap<string, number>;
visibleImageIndexByPath: ReadonlyMap<string, number>;
imageListRevision: number;
```

Definitions:

- Keys use the repository's existing Windows-safe normalized path form: replace backslashes with
  slashes and lowercase.
- `allImageIndexByPath` indexes `allImages`.
- `visibleImageIndexByPath` indexes curation-filtered `images`.
- `imageListRevision` increments exactly once for a committed transaction that changes either
  array's membership or order. It does not increment for current-index, zoom, pan, rotation,
  slideshow pause, or other unrelated state changes.
- Maps are treated as immutable. Never mutate a map already stored in Zustand.

## Files Expected to Change

- `src/state/viewerStore.ts`
- `src/state/viewerStore.test.ts`
- `src/services/folderWatcherReconciliation.ts`
- `src/services/folderWatcherReconciliation.test.ts`
- `src/hooks/useImageNavigation.ts`
- `src/hooks/useSlideshow.ts` only where it can consume the revision/index safely
- `src/App.tsx`, compare/projector helpers, and selection helpers only for verified repeated path
  lookups

## Implementation Steps

1. Add one exported `normalizePathKey` helper in a neutral service. Replace local duplicate helpers
   only in files touched by this task.
2. Add a pure `buildImageIndexByPath(images)` helper. If duplicate normalized paths appear, retain
   the first index and add a development-only warning; folder state must not throw.
3. Create one viewer-store helper that receives next `allImages` and next visible `images`, compares
   path order with current arrays, and returns:
   - unchanged map references and revision when order/membership did not change.
   - new maps and `revision + 1` when either array changed.
4. Route every store mutation that changes image arrays through that helper:
   - `setImages`.
   - curation filter and curation synchronization.
   - remove one/many images.
   - folder clear/reset.
5. Replace path-to-index `findIndex` in selection-preservation hot paths with the appropriate map.
   Use visible map for navigation/current index and all map for folder membership.
6. In watcher reconciliation, build a draft map once, not once per change. Preserve existing output
   behavior.
7. Do not store Sets/Maps in persisted settings or serialize them across Tauri.
8. Add a development assertion helper used in tests to verify map entries match their arrays.

## Required Tests

- Maps are correct after initial set, re-sort, filter, unfilter, single removal, bulk removal, and
  folder clear.
- Path normalization treats slash direction and Windows case consistently.
- Revision increments once per actual list transaction.
- Revision does not increment when `setImages` receives equivalent path order and metadata-only
  objects unless a consumer explicitly needs a metadata revision. For this task, metadata-only
  changes keep the list revision unchanged.
- Current path preservation uses the visible map after sort/filter.
- Duplicate normalized paths do not corrupt the first mapping.
- Zoom, pan, current-index-only navigation, and slideshow pause leave map identities and revision
  unchanged.
- Add a large synthetic list test that performs lookups through the map. Do not use wall-clock timing
  as the assertion.

## Acceptance Criteria

- Common path-to-index operations are O(1) after a list transaction.
- No render constructs a full path map solely to locate one current image.
- Maps and arrays cannot drift after any tested image-list mutation.
- Current folder behavior is unchanged for users.
- No backend or persistence architecture is added.

## Validation Commands

```powershell
pnpm run test:run -- src/state/viewerStore.test.ts src/services/folderWatcherReconciliation.test.ts src/hooks/useImageNavigation.test.ts
pnpm run test:run
pnpm run build
```

## Follow-Up, Not Part of This Task

After path indexes are stable, create a separately approved task for paged Rust folder-index reads
and partial frontend hydration. That later task must define page eviction, total count, current-path
lookup across unloaded pages, curation filtering, and watcher behavior before implementation.

## Reviewer Checklist

- Inspect every mutation of `allImages` and `images`; each must update indexes atomically.
- Confirm normalization matches existing Windows behavior.
- Confirm map reads do not introduce stale closures in event callbacks.
- Reject paging, SQLite, or broad store replacement in this PR.
