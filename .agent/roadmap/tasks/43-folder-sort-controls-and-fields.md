# 43 - Folder Sort Controls, Direction, and Creation Date

## Priority and Type

- Priority: P1
- Type: new functionality and UI/UX
- Dependency: task 42 must be merged first

## Goal

Users must be able to change the active folder order from the viewer and contact sheet without
opening Settings. Supported criteria must be Filename, Date Created, Date Modified, File Size, and
Random. Non-random criteria must support ascending and descending direction.

## Product Decisions

These decisions are fixed for this task:

- The existing Settings control becomes “Default folder sort”.
- Changing sort from the viewer or contact sheet updates the active folder immediately and saves the
  same choice as the default for future folders.
- Defaults are Filename + Ascending.
- Date Created and Date Modified default to Descending only during migration from the old `date`
  setting. Once the user chooses a direction, preserve it.
- File Size honors the selected direction.
- Random ignores direction. The direction control is disabled while Random is selected.
- Selecting Random creates one shuffled order. That order must remain stable until the user chooses
  another sort, clicks “Reshuffle”, opens another folder, or starts a new app session.
- Folder watcher changes must not reshuffle all unchanged images. Keep existing paths in their
  current relative order and place newly added paths at randomized positions.
- Slideshow shuffle remains independent. Folder Random order must not toggle `shuffleSlideshow`, and
  slideshow shuffle must not change the folder order.

## Data Model Changes

1. Extend `ImageFile` with `created_at: string | null`.
2. Replace the ambiguous Date meaning in frontend settings with:
   - `sortOrder: 'name' | 'created' | 'modified' | 'size' | 'random'`
   - `sortDirection: 'ascending' | 'descending'`
3. Add Rust settings field `sort_direction` with default `ascending`.
4. Keep backward compatibility for existing settings:
   - old `sort_order: 'date'` becomes `sortOrder: 'modified'` and `sortDirection: 'descending'` when
     no saved direction exists.
   - old `name`, `size`, and `random` keep their criterion.
   - an unknown criterion becomes Name.
   - an absent/unknown direction becomes Filename Ascending, Created Descending, Modified
     Descending, or Size Descending according to the resolved criterion. Direction is ignored for
     Random.
   - Rust deserialization must preserve the distinction between an absent direction and an explicit
     `ascending` value. Use an optional deserialization field or a custom migration; do not apply a
     Rust serde default before the legacy `sort_order` migration can inspect absence.
5. Rust folder metadata must populate `created_at` using `std::fs::Metadata::created()` when the
   platform provides it. Failure is represented as null; it must not fail the scan.
6. Increment the persistent folder-index schema version because cached `ImageFile` records gain a
   field. Old index shards may be discarded and rebuilt; do not attempt an in-place JSON migration.

## UI Requirements

Add one reusable `FolderSortMenu` component and render it in both:

- the viewer's More Actions menu in `ViewerChrome`.
- the contact-sheet top-bar More Actions menu.

The menu must contain:

- A criterion select labelled “Sort by” with Filename, Date Created, Date Modified, File Size, and
  Random.
- A direction select labelled “Direction” with Ascending and Descending.
- A “Reshuffle” button shown only when Random is active.
- A concise current-state label in the menu summary, for example `Sort: Filename ↑` or
  `Sort: Random`.

Update Settings to show the same criterion and direction controls under Navigation, titled “Default
folder sort”. Do not add a second, different set of labels.

## Implementation Steps

1. Complete task 42 and reuse its deterministic comparators and Fisher-Yates helper.
2. Update TypeScript types, Rust settings types/defaults, conversion functions, diagnostic snapshot,
   and settings tests.
3. Add `created_at` to Rust `ImageFile`, folder scan results, watcher payload records, folder index,
   and TypeScript mocks/fixtures.
4. Update `sortImages` to accept criterion and direction. Apply direction to the primary comparison,
   then always apply natural filename/path ascending as the deterministic final tie-breaker.
5. Represent stable Random mode explicitly. Do not call Fisher-Yates during unrelated renders,
   watcher modifications, or curation-state updates.
6. Build `FolderSortMenu` once and share it between viewer and contact sheet.
7. Preserve the current image by path after sort, reshuffle, refresh, and watcher reconciliation.
8. Preserve current curation-filter ordering rules:
   - All Images and Unreviewed retain folder order.
   - Favorites and rated filters keep their existing rating/favorite/updated-at priority.
   - When two entries have equal curation priority, their tie order comes from the active folder
     order, including a stable Random order.
9. Update README's feature wording only if implementation behavior differs from the current text.

## Required Tests

- Settings migration from each old `sort_order` value.
- Invalid sort criterion and direction fall back safely.
- Created and modified dates sort independently.
- Null created dates sort after known dates in Descending and before known dates in Ascending only
  if the product explicitly chooses that behavior. For this task, null values must always be last,
  regardless of direction.
- Size and name sort in both directions.
- Equal primary values use natural name/path tie-breakers.
- Viewer menu and contact-sheet menu render the same options and update the setting.
- Random order remains unchanged after an existing file is modified.
- Random order preserves unchanged relative order and inserts a newly added file.
- Reshuffle changes order under an injected deterministic random sequence.
- Sorting and reshuffling preserve the selected path.
- Rust tests cover `created_at` success where supported and null fallback without scan failure.
- Persistent folder-index schema mismatch rebuilds safely.

## Acceptance Criteria

- A user can sort the active folder from viewer and contact sheet.
- Filename, Created, Modified, Size, and Random are available.
- Ascending/Descending is available and unambiguous for non-random criteria.
- The saved choice becomes the default for later folders.
- Random folder order and randomized slideshow remain independent features.
- Watcher and curation updates do not unexpectedly reshuffle the folder.
- Existing settings and folder indexes do not crash after upgrade.

## Validation Commands

```powershell
pnpm run test:run
pnpm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

## Non-Goals

- No recursive subfolder scanning.
- No dimension, rating, EXIF capture date, or file-type sorting.
- No drag-to-manually-order mode.
- No database/paged catalog migration.
