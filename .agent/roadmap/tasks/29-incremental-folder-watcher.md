# 29 - Incremental Folder Watcher

## Roadmap Item

Incremental folder watcher: update the current folder when files are created, deleted, renamed, or
modified without requiring a full manual rescan every time.

## Goal

LightFrame should reflect external edits, downloads, exports, and deletes while staying responsive.
The watcher should batch noisy filesystem events and update only the affected image records when
possible.

## Current Code Context

- `src/hooks/useImageNavigation.ts` has `refreshFolder`, which rescans the current folder and
  preserves selection.
- `src-tauri/src/commands.rs` has `scan_folder` but no filesystem watcher command.
- `src/services/imageAssetCache.ts` and `src/services/thumbnailCache.ts` expose invalidation helpers.
- Task 28 may introduce a persistent folder index that this watcher can update incrementally.

## Implementation Steps

1. Add a Rust watcher for the active folder:
   - use a narrow dependency such as `notify` if acceptable.
   - expose `watch_folder(folder_path)` and `unwatch_folder()` behavior through Tauri events.
2. Batch filesystem events:
   - debounce bursts for a short interval.
   - coalesce repeated modified events for the same path.
   - avoid updating the UI once per raw filesystem event.
3. Classify event effects:
   - added supported image.
   - removed current or non-current image.
   - renamed image.
   - modified current or non-current image.
   - unsupported file ignored.
4. Update frontend folder state:
   - insert added images using the active sort order.
   - remove deleted images while preserving nearest selection.
   - invalidate thumbnail and image asset caches for modified paths.
   - if too many events arrive, fall back to `refreshFolder`.
5. Integrate with persistent index if task 28 exists:
   - update changed records incrementally.
   - schedule a full reconciliation when event confidence is low.
6. Add user control:
   - setting to enable or disable auto-refresh.
   - default enabled only if the watcher proves stable in testing.

## Acceptance Criteria

- Added supported images appear without manual refresh.
- Deleted images disappear without crashing or leaving invalid selection.
- Modified current image invalidates preview/full/thumbnail caches.
- Event storms are batched and do not freeze the UI.
- Manual refresh remains available and reliable.

## Tests

- Rust tests for event classification helpers.
- Frontend tests for add/remove/modify state reconciliation.
- Frontend tests for fallback to full refresh after large event batches.
- Run `cargo test`.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm raw filesystem event noise is debounced and coalesced.
- Confirm current image selection remains stable after deletes and renames.
- Confirm cache invalidation happens on modified files.
- Confirm watcher shutdown occurs when changing folders or closing the window.
