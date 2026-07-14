# 37 - Atomic, Non-Blocking Curation Persistence

## Priority and Type

- Priority: P2
- Type: persistence reliability and performance
- Dependencies: none

## Goal

Keep the existing JSON curation format and command signatures, but move all mutex acquisition and
filesystem work off the async runtime thread and make every rewrite atomic.

## Explicit Scope Decision

Do not add SQLite, another database, schema migration, or new frontend state in this task. JSON
remains the storage format. A database evaluation is a separate future task supported by measured
evidence, not an implementation choice left to this task's assignee.

## Current Problem

`read_curation_metadata`, `write_image_curation`, `write_image_curation_batch`, and
`clear_image_curation` are async Tauri commands, but they acquire a process mutex and execute full
JSON read/parse/write filesystem work directly in the async body. Writes use direct `fs::write`, so
interruption can leave a partial file.

## Required Native Design

Create blocking helpers with no Tauri async work inside them:

```text
read_curation_metadata_blocking(path) -> HashMap
write_image_curation_blocking(path, update) -> Result
write_image_curation_batch_blocking(path, updates) -> Result
clear_image_curation_blocking(path, file_path) -> Result
write_curation_metadata_atomically(path, metadata) -> Result
```

Each public async Tauri command must:

1. Resolve the curation path before or inside the closure without borrowing non-`'static` values.
2. Move owned inputs into `tauri::async_runtime::spawn_blocking`.
3. Acquire `CURATION_METADATA_LOCK` inside the blocking closure.
4. Perform the complete read-modify-write transaction while holding the lock.
5. Await the join and flatten both join errors and helper errors into the existing `Result<_, String>`
   shape.

## Atomic Write Algorithm

Use this exact sequence:

1. Create the parent directory if missing.
2. Serialize metadata before touching the destination file.
3. Create a uniquely named temporary file in the same directory as `curation.json`.
4. Open the temp file with create-new semantics so an existing temp file is never overwritten.
5. Write all bytes and call `sync_all` on the temp file.
6. Replace the destination:
   - On Windows, use a replace/rename path that can replace an existing file. If the standard rename
     cannot replace, use the existing `windows` dependency with the minimum file-system feature.
   - On other platforms, use same-filesystem rename.
7. Best-effort remove the temp file after any failure.
8. Never delete the valid destination before a replacement temp file is fully written and synced.

Keep empty-map behavior explicit: writing an empty map may write `{}` or remove the file only if the
existing behavior and tests specify that choice. For this task, write `{}` atomically to minimize
behavior change.

## Corrupt Input Behavior

Preserve the existing read fallback: corrupt JSON loads as an empty map and logs a warning. Before a
write replaces a corrupt existing file, copy it once to `curation.json.corrupt-<timestamp>` on a
best-effort basis. Failure to create the backup must be logged but must not prevent the user's new
curation update from being saved.

## Files Expected to Change

- `src-tauri/src/commands.rs`
- A new focused module such as `src-tauri/src/curation_storage.rs` is preferred.
- `src-tauri/src/lib.rs` for module declaration/command registration if needed.
- `src-tauri/Cargo.toml` only if an additional existing Windows feature is required.
- Frontend files should not change unless a command mock needs adjustment.

## Required Tests

- Legacy JSON loads without migration.
- Single update and batch update persist correct normalized records.
- Clear writes the expected empty/non-empty JSON.
- Temp and destination are in the same directory.
- Serialization failure leaves destination untouched where a failure can be injected.
- Replacement failure leaves destination untouched and cleans the temp file.
- Corrupt source is backed up best-effort, then replaced by valid JSON.
- Concurrent single/batch updates are serialized and no update is lost.
- A test-only blocking hook proves the async command yields to another Tokio task while disk helper
  work is blocked. Do not use a fragile elapsed-time threshold.
- Join failure is returned as a readable command error.

## Acceptance Criteria

- No curation mutex or filesystem operation runs directly in a public async command body.
- Every curation rewrite is same-directory and atomic.
- Existing user JSON remains compatible.
- Failed writes do not truncate or delete the prior valid file.
- Frontend favorites, ratings, filters, and batch actions behave unchanged.

## Validation Commands

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm run test:run -- src/state/curationStore.test.ts src/state/viewerStore.test.ts
pnpm run build
```

## Non-Goals

- No SQLite or key-value store.
- No JSON schema redesign.
- No cloud metadata sync.
- No curation UI changes.

## Reviewer Checklist

- Confirm lock acquisition occurs inside `spawn_blocking`.
- Confirm read-modify-write stays under one lock.
- Confirm the old destination survives every injected pre-replace failure.
- Reject unrelated database or frontend refactors.
