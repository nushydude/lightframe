# 07 - Folder Scan Optimization

## Roadmap Item

Folder scan optimization: precompute natural sort keys during folder scans and avoid repeated
string/key allocation inside sort comparators.

## Goal

Natural sorting should compute each filename sort key once per scan instead of recomputing both keys
inside every comparator call.

## Current Code Context

- `src-tauri/src/commands.rs` has `natural_sort_key(&str) -> Vec<NatSortPart>`.
- `scan_folder` currently does:
  `images.sort_by(|a, b| natural_sort_key(&a.file_name).cmp(&natural_sort_key(&b.file_name)))`.
- `natord` is already in `Cargo.toml` but current code uses custom sort parts.

## Implementation Steps

1. Keep existing natural sort behavior unless tests show a clear bug.
2. Create an internal struct:
   `ScannedImage { image: ImageFile, sort_key: Vec<NatSortPart> }`
3. During folder scan, push `ScannedImage` with `sort_key: natural_sort_key(&file_name)`.
4. Sort `Vec<ScannedImage>` by `sort_key`, then map back to `Vec<ImageFile>`.
5. Add tie-breakers to keep ordering deterministic:
   - first compare sort keys
   - then compare lowercase filename
   - then compare full path.
6. Consider changing `NatSortPart::Str(String)` to store lowercase strings exactly once.
7. Add tests that prove `natural_sort_key` is called once per image if practical. If direct call
   counting is awkward in Rust, add a benchmark-style comment is not enough; instead test sorting
   output and keep implementation visibly precomputed.
8. Do not change frontend sort behavior in this task.

## Acceptance Criteria

- Folder scans return the same natural name order as before.
- Sort key allocation happens once per image entry.
- Ordering is deterministic for duplicate names or equivalent natural keys.
- Rust tests cover mixed numeric names.

## Tests

- Extend Rust tests in `src-tauri/src/commands.rs`.
- Add cases:
  - `image1`, `image2`, `image10`
  - `IMG2` and `img2` tie behavior
  - paths with no extension are excluded as before.
- Run `cargo test`.
- Run `cargo clippy -- -D warnings`.
- Run `cargo fmt -- --check`.

## Reviewer Focus

- Confirm comparator does not call `natural_sort_key`.
- Confirm sort behavior did not drift from existing expectations.
- Confirm no unnecessary dependency is added.

