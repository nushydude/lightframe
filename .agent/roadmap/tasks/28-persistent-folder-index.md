# 28 - Persistent Folder Index

## Roadmap Item

Persistent folder index: cache folder file metadata across sessions so large folders can reopen
quickly while a background refresh verifies the filesystem.

## Goal

Folders with thousands of images should show useful results almost immediately after they have been
opened once. LightFrame should reuse known file metadata, dimensions, thumbnail keys, and sort data
while validating changes in the background.

## Current Code Context

- `src-tauri/src/commands.rs` scans folders synchronously inside a blocking worker and returns a full
  image list.
- `scan_folder_blocking` already captures path, file name, extension, size, modified time, and
  natural sort keys.
- `src/hooks/useImageNavigation.ts` waits for `scanFolder` before setting folder images for normal
  folder opens.
- `src/services/imageSorting.ts` handles frontend sort orders after scan results arrive.
- `src-tauri/src/thumbnails.rs` already uses source metadata in thumbnail cache keys.

## Implementation Steps

1. Choose a persistent index store:
   - SQLite is preferred if the dependency is acceptable.
   - JSONL or small sharded JSON files are acceptable for a narrower first pass.
2. Store per-file records:
   - canonical path.
   - folder path.
   - file name and extension.
   - size and modified time.
   - optional dimensions and format.
   - precomputed natural sort key or stable sort fields.
   - last seen timestamp.
3. Add Rust commands:
   - `read_folder_index(folder_path) -> Vec<ImageFile>` for warm startup results.
   - `refresh_folder_index(folder_path) -> Vec<ImageFile>` for verified results.
   - keep `scan_folder` behavior compatible for existing callers during migration.
4. Update folder open flow:
   - if cached index exists, show it quickly with a refreshing state.
   - run verified scan/index refresh in the background.
   - preserve current image selection after verified results arrive.
5. Add invalidation rules:
   - remove index entries for files no longer present after refresh.
   - update records when size or modified time changes.
   - version the schema so old index data can be discarded safely.
6. Integrate with thumbnails:
   - use indexed size and modified time to request thumbnails immediately.
   - avoid blocking visible grid rendering on dimensions unless needed.

## Acceptance Criteria

- Reopening a previously indexed large folder can show cached image entries before full verification.
- Background verification reconciles added, removed, and modified files.
- Existing open image and open folder flows still work if the index is missing or corrupt.
- Index schema versioning can discard incompatible old data.
- Sorting remains stable before and after verification.

## Tests

- Rust tests for index read/write and schema version handling.
- Rust tests for reconciling added, removed, and modified files.
- Frontend tests for warm index result followed by verified result.
- Run `cargo test`.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm corrupt index data cannot prevent opening a folder.
- Confirm cached results are clearly refreshed and reconciled.
- Confirm path canonicalization is consistent with thumbnail cache keys.
- Confirm the chosen storage dependency is justified and narrow.
