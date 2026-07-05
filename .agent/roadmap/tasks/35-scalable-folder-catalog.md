# 35 - Scalable Folder Catalog

## Roadmap Item

Audit follow-up: make large-folder open, indexing, lookup, and hydration scale beyond all-at-once
arrays.

## Goal

LightFrame should remain responsive when opening very large folders. Folder scanning and index reads
should avoid forcing the frontend to receive, sort, diff, and repeatedly search one full image array
for every workflow.

## Current Code Context

- `scan_folder_blocking`, `read_folder_index_blocking`, and `refresh_folder_index_blocking` return
  full `Vec<ImageFile>` results.
- `folder_index` stores each folder as one JSON shard containing every image record.
- The viewer store keeps `allImages` and filtered `images` arrays and many call sites use
  `findIndex`, `map`, `filter`, and full-array `Set` construction.
- Contact sheet and thumbnail strip virtualize rendering, but the data model still hydrates the
  entire folder at once.

## Implementation Steps

1. Design a folder catalog abstraction that can support both current full-array behavior and future
   paged reads:
   - stable folder revision token.
   - path-to-index lookup.
   - current visible order.
   - total count.
2. Start with the lowest-risk frontend foundation:
   - maintain path indexes alongside image arrays in `viewerStore`.
   - replace repeated linear path lookups in navigation, projector sync, compare state, and
     selection reconciliation.
   - avoid rebuilding full `Set` or path maps on every render where a revision-scoped map can be
     reused.
3. Extend the Rust folder index API if needed:
   - preserve existing commands for compatibility.
   - add metadata/page commands only if the frontend can consume them in this task.
4. If implementing paged reads in this task, add:
   - a page query by folder, offset, limit, and sort order.
   - a first-page-fast open path.
   - background hydration for contact sheet and search/filter workflows.
5. Keep curation filters and sort orders behaviorally identical.
6. Add telemetry around folder open sizes and first-image readiness if helpful.

## Acceptance Criteria

- Current folder open behavior is unchanged for normal folders.
- Large-folder path lookup hot spots use indexed lookup instead of repeated full-array scans.
- The data model has a clear migration path toward paged folder index reads.
- If paged commands are added, they are covered by Rust unit tests and maintain non-Windows
  compatibility.
- Contact sheet and thumbnail strip virtualization still work with the updated catalog state.

## Tests

- Run focused viewer store and navigation tests.
- Add tests for path-index reconciliation and current-image preservation.
- If Rust APIs change, add folder index tests.
- Run `pnpm run test:run`.
- Run `pnpm run build`.
- Run `cargo test --manifest-path src-tauri/Cargo.toml` if native code changes.

## Reviewer Focus

- Confirm this task improves actual large-folder operations instead of only moving code around.
- Confirm indexes stay synchronized after folder refresh, watcher updates, delete, move, curation
  filters, and sort changes.
- Confirm memory growth is bounded and stale folder indexes are discarded.
- Confirm any Rust API additions are incremental and backwards compatible.
