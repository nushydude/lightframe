# 40 - Tauri Capability Scope Hardening

## Roadmap Item

Audit follow-up: reduce broad filesystem and asset protocol permissions while preserving image viewer
workflows.

## Goal

LightFrame needs broad user-selected file access, but the Tauri capability and asset scopes should
be as narrow as practical. The frontend should access files through selected folders, generated
cache paths, and explicit commands instead of unrestricted wildcard permissions where possible.

## Current Code Context

- `tauri.conf.json` enables asset protocol scope `["**"]`.
- `src-tauri/capabilities/default.json` allows open-path and filesystem scope `**`.
- Viewer features include opening arbitrary selected files/folders, generated thumbnails/previews,
  reveal in folder, external editor launch, clipboard copy, and diagnostics export.
- Several workflows rely on `convertFileSrc` and command-mediated filesystem access.

## Implementation Steps

1. Inventory every frontend use of file URLs, asset URLs, and filesystem/open-path plugin
   permissions.
2. Define the minimum practical access model:
   - selected image files and folders.
   - app cache/generated asset directories.
   - explicit diagnostics export destination.
   - explicit external editor path when configured.
3. Tighten Tauri asset protocol scope first if generated assets can be routed through app cache
   paths.
4. Tighten filesystem plugin permissions or remove unused broad plugin access where commands already
   provide the needed operation.
5. Keep drag-and-drop, file association startup, recent folders, projector window, thumbnails,
   previews, edit exports, reveal, and external editor behavior intact.
6. Add regression tests where permission-sensitive logic is command-level and testable.

## Acceptance Criteria

- Wildcard `**` permissions are removed or justified with a documented reason.
- Normal image open, folder open, previews, thumbnails, edit output, reveal, and external editor
  workflows still work.
- Generated asset access remains stable across app restarts.
- The app does not expose broader plugin permissions than needed for current workflows.

## Tests

- Run `pnpm run build`.
- Run `cargo test --manifest-path src-tauri/Cargo.toml`.
- Run a Tauri dev/build smoke test if permission changes require runtime validation.
- Manually verify open file, open folder, drag/drop, preview/thumbnail rendering, reveal in folder,
  and external editor launch on Windows.

## Reviewer Focus

- Confirm permissions are actually narrower, not just rearranged.
- Confirm user-selected arbitrary folders remain supported through a clear access path.
- Confirm generated cache asset URLs still render.
- Confirm security hardening does not silently break projector or startup-file workflows.
