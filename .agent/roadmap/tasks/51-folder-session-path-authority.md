# 51 - Folder Session Path Authority

## Priority and Type

- Priority: P0
- Type: Tauri IPC security architecture
- Dependencies: task 50 may run independently; no code dependency
- Expected branch: `codex/folder-session-path-authority`
- Required final gate: `pnpm run ci:local`

## Goal

Stop trusting arbitrary filesystem paths supplied by the WebView for image reads and mutations.
Opening a file or folder must create a backend-owned session, and subsequent image commands must
resolve opaque IDs through that session.

This task creates the authority model and migrates image/file commands. It does not yet narrow the
asset-protocol glob or split projector capabilities; task 52 performs that final configuration step.

## Threat Model

Assume untrusted JavaScript can invoke every registered application command from an authorized
window. The Rust layer must prevent that code from:

- reading or decoding an arbitrary file that the user never opened.
- moving or trashing an unrelated file.
- choosing an arbitrary executable or script to launch.
- writing an edit outside an explicitly selected destination.
- exploiting path aliases, case differences, `..`, symlinks, junctions, or reparse points to escape
  a granted folder.

The authority is a defense-in-depth boundary. Do not rely only on the current CSP or React code.

## Required Domain Model

Introduce backend-managed state with opaque random identifiers:

```text
FolderSessionId
ImageId
DestinationGrantId
ExternalEditorGrantId
```

Minimum session data:

- canonical root folder.
- canonical image records keyed by `ImageId`.
- source metadata needed for cache invalidation.
- creation time and last-used time.
- owning window label or explicit shared-read policy.
- invalidation state when a folder is closed or replaced.

IDs must not contain raw paths. Do not derive an ID solely from a predictable path hash.

## Command Contract

Define and document commands equivalent to:

```text
open_folder_session(folder_path) -> FolderSessionSnapshot
open_file_session(file_path) -> FolderSessionSnapshot
refresh_folder_session(session_id) -> FolderSessionDelta or Snapshot
close_folder_session(session_id)
grant_destination(folder_path) -> DestinationGrantId
grant_external_editor(application_path) -> ExternalEditorGrantId
```

`FolderSessionSnapshot` must expose image IDs plus the display metadata required by React. It may
temporarily include display paths for UI/title compatibility, but privileged commands must ignore
frontend paths and resolve the authoritative path from `ImageId`.

Migrate at least these command families:

- metadata, caption, EXIF, preview, thumbnail, and tile.
- curation read/write/clear.
- clipboard and reveal.
- trash, copy, move, crop, scale, rotation, and overwrite.
- external editor launch.
- folder watcher setup and refresh.

## Canonicalization and Containment Rules

1. Canonicalize a selected root and every candidate file on the Rust side.
2. Reject non-files and unsupported image extensions where an image is required.
3. On Windows, compare normalized canonical paths case-insensitively.
4. Do not follow a symlink/reparse-point escape outside the granted root.
5. A newly created output may not be canonicalized yet. Canonicalize its parent, validate the final
   file name and extension, then construct the target below that parent.
6. A destination grant authorizes writes only under its canonical directory.
7. Overwrite authorizes only the exact source image resolved from the session.
8. Trash and move authorize only session image IDs.
9. Session invalidation must make stale IDs fail closed with a typed error.

## Frontend Migration Requirements

- Add a typed session service rather than passing IDs ad hoc through components.
- Store session ID and image IDs in viewer state.
- Preserve current image selection by stable image identity during refresh.
- Keep raw display paths available only where the current UI genuinely needs them.
- Recent folders may remain path-based settings because reopening them is an explicit user action;
  reopening must create a fresh session.
- Projector synchronization must send an image ID/session reference, not a privileged path.
- Cache keys must remain correct after file mutation and watcher updates.

## Compatibility and Rollout

- Do not maintain indefinitely callable legacy path commands.
- A short internal migration adapter is acceptable while implementing the branch, but the final
  invoke handler must not expose the old privileged signatures.
- Settings and existing curation data remain path-keyed on disk in this task. The backend maps an
  authorized image ID to its canonical path before accessing those stores.
- File association, CLI startup, recent-folder reopening, drag-and-drop, and dialog opening all
  create sessions through trusted backend commands.

## Expected Files

- New focused Rust modules under `src-tauri/src/authority/` or equivalent
- `src-tauri/src/lib.rs`
- `src-tauri/src/commands/*.rs`
- `src-tauri/src/folder_watcher.rs`
- `src/services/tauriCommands.ts` or a replacement typed IPC facade
- `src/types/image.ts`
- `src/state/viewerStore.ts`
- startup, navigation, projector, cache, and viewer-action consumers
- Corresponding Rust and Vitest tests

## Required Rust Tests

- Open-folder session returns only supported files.
- Image IDs do not reveal or deterministically equal raw paths.
- An image ID cannot be used with a different session.
- A stale/closed session is rejected.
- A path using `..` cannot escape a destination grant.
- A symlink/junction/reparse escape is rejected on supported platforms.
- Case and slash variants resolve consistently on Windows.
- Trash, move, overwrite, and external editor commands reject unauthorized IDs/grants.
- A refresh preserves IDs for unchanged canonical files and removes IDs for deleted files.
- A rename produces an intentional identity result documented by the implementation.
- Secondary-window access follows the declared read-sharing rule.

## Required Frontend Tests

- Opening a folder stores a session and image IDs.
- Navigation and sorting preserve the selected image ID.
- Folder watcher reconciliation consumes authoritative session changes.
- Errors from expired sessions return the app to a recoverable state.
- Projector and compare views resolve the same authorized image without raw-path IPC.
- Delete and edit flows use IDs and preserve existing confirmation/toast behavior.

## Manual Smoke Matrix

Use only synthetic files:

- Open single file.
- Open folder.
- Open by drag-and-drop.
- Open by CLI/file association if supported by the smoke harness.
- Navigate, filter, sort, compare, and project.
- Generate thumbnail/preview/tile.
- Copy, move, trash, rotate, crop copy, crop overwrite, and scaled export.
- Reveal and open in configured external editor.
- Modify, rename, add, and delete files while the watcher is active.
- Close the folder and confirm stale commands fail.

## Validation Commands

```powershell
pnpm run test:run
cargo test --manifest-path src-tauri/Cargo.toml
pnpm run ci:local
pnpm tauri dev
```

## Acceptance Criteria

- Privileged image/file commands no longer accept an arbitrary source path from the frontend.
- Every destructive/write operation is authorized by session identity or an explicit destination
  grant.
- All existing open and review workflows remain functional.
- Stale and cross-session identifiers fail closed.
- No data migration is required for existing users.
- The code contains a short threat-model comment or architecture note explaining the boundary.

## Reviewer Checklist

- Trace every registered command that reads, writes, deletes, or launches a process.
- Reject any bypass that still accepts an arbitrary source path.
- Review canonicalization, symlink/reparse behavior, and not-yet-existing outputs.
- Confirm session state cannot grow without bound; closed/replaced sessions must be evicted.
- Confirm tests use real temporary directories and filesystem aliases where platform support exists.

