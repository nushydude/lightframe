# 03 - Disk-Backed Thumbnails

## Roadmap Item

Disk-backed thumbnails: cache generated thumbnails by file path, modified time, and size to avoid
decoding the same large images across sessions.

## Goal

Generated thumbnails should be persisted under the app cache directory and reused across app
sessions when the source file path, modified timestamp, and file size still match.

## Current Code Context

- `src-tauri/src/commands.rs` has `get_thumbnail(file_path)` that always opens, decodes, resizes,
  JPEG-encodes, base64-encodes, and returns a data URL.
- `ImageFile` already includes `size_bytes` and `modified_at`.
- The frontend thumbnail cache currently calls by path only.

## Implementation Steps

1. In Rust, add a thumbnail cache helper near `get_thumbnail` or split into
   `src-tauri/src/thumbnails.rs` if the file becomes too large.
2. Use `app.path().app_cache_dir()` to create a `thumbnails` folder.
3. Change the command signature to accept enough identity fields:
   - `file_path: String`
   - optional `size_bytes: Option<u64>`
   - optional `modified_at: Option<String>`
4. If the frontend cannot provide size and modified time for a path, compute them in Rust.
5. Create a stable cache key from:
   - normalized absolute path
   - modified seconds
   - size bytes
   - thumbnail format version, for example `v1`
6. Hash the cache key with a Rust standard or existing dependency-safe approach. If adding a crate,
   use a small hashing crate and document why. A simple sanitized filename is not enough because
   paths can be long.
7. Store thumbnails as JPEG files, for example `<hash>.jpg`.
8. On cache hit, read the JPEG bytes and return the existing `data:image/jpeg;base64,...` format.
9. On cache miss, generate the thumbnail, write the JPEG bytes to disk, then return the data URL.
10. Add best-effort cache cleanup:
   - run occasionally inside `get_thumbnail`
   - cap by entry count or total bytes
   - ignore cleanup failures but do not ignore generation failures.
11. Update `src/services/tauriCommands.ts` and thumbnail cache service to pass `size_bytes` and
    `modified_at` when available. If the shared cache only has a path, allow fallback.

## Acceptance Criteria

- First request for a thumbnail generates and writes a cache file.
- Second request with unchanged source metadata reads from disk without decoding the original image.
- Changing source file size or modified timestamp creates a new cache entry.
- Cache failures do not crash the app; they fall back to generating thumbnails.
- The Tauri command remains compatible for callers that only pass `filePath`.

## Tests

- Add Rust tests for cache key stability and metadata changes.
- Add a Rust test that creates a temporary image, requests a thumbnail twice, and verifies the cache
  file exists.
- Run `cargo test` from `src-tauri`.
- Run `cargo fmt -- --check` from `src-tauri`.
- Run `pnpm build` to verify frontend command typing.

## Reviewer Focus

- Verify app cache directory is used, not the source image folder.
- Verify path changes, mtime changes, and size changes invalidate correctly.
- Verify cleanup cannot delete files outside the thumbnail cache directory.

