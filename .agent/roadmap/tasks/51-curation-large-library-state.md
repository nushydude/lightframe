# 51 - Large-Library Curation Loading and State

## Priority and Type

- Priority: P1
- Type: scalability architecture
- Dependencies: tasks 35 and 37

## Goal

Make curation startup, mutation, and filtering scale with the active folder or changed records
instead of the total number of curated images across every library.

## Current Evidence

- `src-tauri/src/curation.rs::read_curation_metadata_locked` reads every shard and extends one
  `HashMap`, so sharding limits write amplification but not startup loading.
- `src/state/curationStore.ts` keeps a global `Record<string, ImageCuration>` and clones it for each
  single or batch mutation.
- `src/state/viewerStore.ts::syncFavoriteFilter` scans all curation entries to rebuild favorite
  paths, then may refilter the full folder.
- The Rust test `benchmark_curation_shards_at_10k_and_100k_entries` is ignored and reports timings
  manually; it does not enforce a deterministic scalability invariant.
- Task 37 owns atomic, non-blocking filesystem commands. This task starts after that contract is
  stable and does not reimplement its write-safety work.

## Required Design

1. Define folder-scoped read semantics that load only records relevant to the active folder, while
   retaining a targeted lookup path for startup files outside a loaded folder.
2. Add a typed Rust/Tauri read API that avoids materializing unrelated shards or records. Document
   path-normalization and folder-boundary behavior on Windows.
3. Replace whole-record cloning for single edits with a state representation whose update cost is
   proportional to changed entries.
4. Maintain favorite/rating indexes incrementally so a mutation does not rescan all curated paths.
5. Integrate with task 35's revision-scoped image indexes without serializing Maps or Sets through
   Tauri or persisted settings.
6. Define folder switch, watcher add/remove, clear, and startup-file hydration behavior before
   implementation.

## Acceptance Criteria

- Opening a folder does not load curation records belonging only to unrelated folders.
- A single favorite or rating change updates a bounded number of records and index entries.
- Curation filter results remain correct after folder switches, batch edits, clears, and watcher
  changes.
- Legacy on-disk curation data remains readable without data loss.
- No async Tauri command performs blocking filesystem work directly; task 37's guarantee remains
  intact.

## Required Tests and Validation

- Add synthetic 10,000- and 100,000-record tests that assert shard/read counts, returned record
  counts, and update cardinality rather than wall-clock duration.
- Test mixed folders with case and slash variants, a startup file outside the active folder, batch
  changes, and clearing the final record.
- Run focused Rust curation tests and frontend curation/viewer-store tests.
- Run `pnpm run ci:local`.

## Non-Goals

- Do not select SQLite or another database without a separate measured design decision.
- Do not duplicate task 37's atomic-write or `spawn_blocking` remediation.

## Reviewer Checklist

- Confirm the read boundary is truly folder-scoped and Windows-safe.
- Confirm the frontend no longer clones or scans global curation state per single mutation.
- Reject wall-clock-only performance tests.
