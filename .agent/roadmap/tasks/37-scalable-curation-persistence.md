# 37 - Scalable Curation Persistence

## Roadmap Item

Audit follow-up: make favorites and ratings persistence scale without blocking on full JSON
read/write cycles for every single-image update.

## Goal

Rating or favoriting an image should stay quick even after a library has many curated images. Disk
persistence should avoid synchronous full-file work on Tauri async commands and should have a path
toward incremental storage.

## Current Code Context

- Frontend curation mutations are serialized in `curationStore`.
- Rust curation commands read the full JSON map, apply an update, and write the full JSON map.
- `read_curation_metadata`, `write_image_curation`, and `write_image_curation_batch` do filesystem
  work directly in async command bodies.
- Batch updates reduce command count but still rewrite the whole metadata file.

## Implementation Steps

1. Move curation file reads and writes behind `spawn_blocking` so filesystem work does not run on the
   async command path.
2. Make writes atomic:
   - write a temp file in the same directory.
   - replace the destination safely.
   - preserve corrupt-file fallback behavior.
3. Add a curation storage boundary that can later swap JSON for SQLite or another kv store without
   changing command signatures.
4. Evaluate whether this task should keep JSON plus atomic/blocking fixes, or migrate to an
   incremental store:
   - if migrating, provide one-time import from existing JSON.
   - preserve JSON recovery behavior or document the migration fallback.
5. Keep frontend optimistic behavior and mutation queue semantics intact.
6. Add tests for single updates, batch updates, corrupt metadata, and atomic replacement failure
   paths where practical.

## Acceptance Criteria

- Single-image and batch curation commands do not perform blocking filesystem work directly on the
  async command body.
- Existing JSON curation files continue to load.
- Failed writes do not leave partially written metadata.
- Frontend favorites/ratings behavior and curation filters are unchanged.
- The storage code has a clear seam for future incremental persistence.

## Tests

- Add Rust tests for atomic curation writes and legacy JSON compatibility.
- Run `cargo test --manifest-path src-tauri/Cargo.toml`.
- Run `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`.
- Run `pnpm run test:run -- src/state/curationStore.test.ts src/state/viewerStore.test.ts`.
- Run `pnpm run build`.

## Reviewer Focus

- Confirm async command bodies are not doing direct blocking file I/O.
- Confirm migration/backward compatibility is safe for existing users.
- Confirm ratings/favorites are not lost on corrupt or failed writes.
- Confirm frontend state still updates only after successful persistence unless explicitly designed
  otherwise.
