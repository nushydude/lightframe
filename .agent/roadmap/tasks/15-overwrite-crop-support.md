# 15 - Overwrite Crop Support

## Roadmap Item

Overwrite crop support: add explicit overwrite flow with confirmation, cache invalidation, and
metadata preservation where possible.

## Goal

After safe save-copy support exists, allow users to overwrite the original with a cropped image only
after explicit confirmation.

## Current Code Context

- Depends on tasks 13 and 14.
- `ViewerChrome` already uses `confirm` and `message` for delete/copy actions.
- `saveRotation` invalidates image cache once task 01 is complete.
- Rust rotation code attempts metadata preservation with `little_exif`.

## Implementation Steps

1. Add Rust command `overwrite_with_crop` or extend crop command with explicit `overwrite: true`.
   Prefer a separate command to avoid accidental overwrite from save-copy callers.
2. Arguments:
   - `file_path: String`
   - `crop_rect: CropRect`
   - optional `rotation_degrees: i32`
3. In frontend, add an "Overwrite" button only when crop mode is active and crop rect is valid.
4. On click, show confirmation:
   - include original file name
   - say the operation modifies the source file
   - require explicit confirmation.
5. In Rust:
   - validate source file exists and is supported.
   - crop pixels.
   - write to a temporary file in the same directory.
   - preserve metadata where possible.
   - atomically replace original where possible.
   - remove temp file on failure.
6. After success:
   - invalidate image asset cache for the current path.
   - invalidate thumbnail cache for the current path.
   - clear crop mode.
   - refresh metadata if the UI shows dimensions/file size.
7. Handle unsupported metadata preservation gracefully:
   - crop still succeeds.
   - return a warning only if useful; do not fail solely because metadata cannot be copied unless
     metadata writing corrupts the output.
8. Add tests for overwrite behavior using temporary files.

## Acceptance Criteria

- Overwrite requires confirmation.
- Cancel leaves original file unchanged.
- Successful overwrite updates visible image and thumbnails.
- Temp files are cleaned up on failure.
- Metadata preservation is attempted for formats where the current stack supports it.

## Tests

- Rust tests:
  - overwrite produces expected dimensions.
  - cancel path is frontend only; test command does not run without direct call.
  - invalid crop returns error and original dimensions remain unchanged.
- Frontend tests:
  - clicking overwrite opens confirmation.
  - cancellation does not call Tauri command.
- Run `cargo test`.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm overwrite cannot happen through Save Copy by mistake.
- Confirm cache invalidation covers image asset and thumbnail caches.
- Confirm temp-file replacement is safe.

