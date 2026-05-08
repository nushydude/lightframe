# 14 - Save Cropped Copy

## Roadmap Item

Save cropped copy: start with safe "Save Copy" behavior before adding overwrite support.

## Goal

Users should be able to save the current crop as a new image file without overwriting the original.

## Current Code Context

- Depends on task 13 crop mode.
- `tauriCommands.ts` has `saveRotatedImage` but no crop command.
- Rust `commands.rs` uses the `image` crate for decode and encode.
- Dialog APIs are already available via `@tauri-apps/plugin-dialog`.

## Implementation Steps

1. Add a Rust command `save_cropped_copy` with args:
   - `file_path: String`
   - `crop_rect: CropRect`
   - `output_path: String`
   - optional `rotation_degrees: i32` if crop should include pending rotation.
2. Define `CropRect` in Rust using pixel coordinates:
   - `x: u32`
   - `y: u32`
   - `width: u32`
   - `height: u32`
3. Convert normalized crop rect to pixel coordinates in frontend using image natural dimensions.
4. Add `saveCroppedCopy` to `src/services/tauriCommands.ts`.
5. Add a "Save Copy" button shown only when crop mode has a valid crop rect.
6. Use `save` dialog from `@tauri-apps/plugin-dialog`:
   - default file name should be original name plus `-cropped`
   - keep extension the same when supported.
7. In Rust:
   - validate source exists
   - validate crop rectangle is inside image bounds
   - reject zero width/height
   - create cropped image
   - save to output path
8. Do not mutate the original image.
9. After save succeeds:
   - optionally open the saved copy or keep current original selected. For this task, keep original
     selected and show a success message.
10. Add command to `src-tauri/src/lib.rs`.

## Acceptance Criteria

- Save Copy writes a new cropped image file.
- Original image is unchanged.
- Invalid crop rectangles return clear errors.
- Canceling the save dialog does nothing.
- The crop UI remains active after saving unless user exits it.

## Tests

- Rust tests:
  - crop valid image and verify output dimensions.
  - reject out-of-bounds crop.
  - reject zero-size crop.
- Frontend tests for crop rect conversion helper.
- Run `cargo test`.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm no overwrite path exists in this task.
- Confirm frontend normalized rect conversion cannot produce out-of-bounds pixel rects due to
  rounding.
- Confirm user cancel path is quiet.

