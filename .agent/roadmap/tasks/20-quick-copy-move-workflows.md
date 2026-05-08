# 20 - Quick Copy/Move Workflows

## Roadmap Item

Quick copy/move workflows: send selected images to common folders from the viewer or contact sheet.

## Goal

Users should be able to copy or move the current image, or selected contact sheet images, into
configured destination folders quickly.

## Current Code Context

- `moveToTrash` exists but no copy/move-to-folder command exists.
- Contact sheet currently selects one image and opens viewer.
- Settings have no destination folders.

## Implementation Steps

1. Extend settings with `quickDestinations`:
   - array of `{ id: string; label: string; path: string }`
2. Add settings UI to manage destinations:
   - add destination using folder picker.
   - remove destination.
   - keep UI minimal and reliable.
3. Add Rust commands:
   - `copy_image_to_folder(file_path, destination_folder) -> copied_path`
   - `move_image_to_folder(file_path, destination_folder) -> moved_path`
4. Rust behavior:
   - validate source file exists.
   - validate destination folder exists.
   - preserve file name.
   - if name conflict, create `name copy`, `name copy 2`, etc.
   - use filesystem copy/rename.
   - for move, prefer `fs::rename`; if cross-device fails, copy then delete original.
5. Add frontend wrappers.
6. Add current-image UI:
   - Copy To menu.
   - Move To menu.
   - each destination appears as an item.
7. Add contact sheet multi-selection:
   - Ctrl/click toggles selection.
   - Shift/click range selection if feasible.
   - bulk copy/move selected images.
8. After move succeeds:
   - remove moved images from viewer store if they came from current folder.
   - update current index safely.
   - invalidate caches for moved paths.
9. After copy succeeds, leave current store unchanged.

## Acceptance Criteria

- User can configure destination folders.
- Current image can be copied to a destination.
- Current image can be moved to a destination and removed from current folder list.
- Contact sheet supports selecting multiple images for bulk copy/move.
- File name conflicts do not overwrite existing files.

## Tests

- Rust tests for copy, move, name conflict, missing destination, and cross-device fallback if
  practical.
- Frontend tests for settings conversion and selection state helpers.
- Run `cargo test`.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm no overwrite occurs on conflicts.
- Confirm move failure cannot delete the source before copy succeeds.
- Confirm bulk operations report partial failures clearly.

