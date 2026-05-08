# 04 - Non-Blocking Image Operations

## Roadmap Item

Non-blocking image operations: move heavy thumbnail, clipboard, EXIF, rotation, and future crop work
onto dedicated blocking worker tasks in Rust.

## Goal

Heavy Rust commands must not block the async runtime or UI responsiveness. CPU-heavy and blocking
file operations should run through `tauri::async_runtime::spawn_blocking`.

## Current Code Context

- `src-tauri/src/commands.rs` marks several commands as `async` but performs blocking work directly:
  `get_thumbnail`, `copy_image_to_clipboard`, `get_exif_metadata`, `save_rotated_image`,
  `get_image_metadata`, and `scan_folder`.
- Future crop work should follow the same pattern.

## Implementation Steps

1. For each heavy command, split the synchronous body into a private helper function:
   - `scan_folder_blocking(folder_path: String) -> Result<Vec<ImageFile>, String>`
   - `get_image_metadata_blocking(file_path: String) -> Result<ImageMetadata, String>`
   - `copy_image_to_clipboard_blocking(file_path: String) -> Result<(), String>`
   - `save_rotated_image_blocking(file_path: String, rotation_degrees: i32) -> Result<(), String>`
   - `get_thumbnail_blocking(file_path: String, ...) -> Result<String, String>`
   - `get_exif_metadata_blocking(file_path: String) -> Result<ExifData, String>`
2. In each Tauri command, call:
   `tauri::async_runtime::spawn_blocking(move || helper(args)).await`
3. Convert join errors to clear strings, for example `"Thumbnail worker failed: {err}"`.
4. Keep helpers pure enough for unit tests.
5. Do not put lightweight settings read/write behind blocking workers unless the reviewer asks;
   those are small and not currently hot-path.
6. If the file becomes hard to read, move helpers into modules:
   - `src-tauri/src/images.rs`
   - `src-tauri/src/settings.rs`
   Keep command exports stable in `commands.rs`.
7. Make sure all command names in `src-tauri/src/lib.rs` remain unchanged.

## Acceptance Criteria

- Heavy image operations run inside blocking tasks.
- Tauri command API names and frontend calls still work.
- Error messages preserve the original failure detail.
- Existing Rust tests pass.
- The change does not introduce shared mutable global state.

## Tests

- Run `cargo test` from `src-tauri`.
- Run `cargo clippy -- -D warnings` from `src-tauri`.
- Run `cargo fmt -- --check` from `src-tauri`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm no blocking image decode or clipboard operation remains directly inside an async command.
- Confirm no non-`Send` data is captured across the blocking worker boundary.
- Confirm helper extraction did not change behavior.

