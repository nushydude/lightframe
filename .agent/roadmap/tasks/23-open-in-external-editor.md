# 23 - Open in External Editor

## Roadmap Item

Open in external editor: launch the current image in a configured editor such as Paint.NET for
deeper edits outside LightFrame.

## Goal

Users should be able to send the current image to an external editor without manually browsing for
the file in Explorer. The first version should prioritize a simple, reliable workflow on Windows
while keeping the door open for cross-platform defaults later.

## Current Code Context

- `src/services/tauriCommands.ts` already uses `@tauri-apps/plugin-opener` for reveal and URL
  actions.
- `src/services/viewerActions.ts` contains current-image actions with shared dialog-based error
  handling.
- `src/components/ViewerChrome.tsx` already exposes top-bar actions like reveal, copy, and delete.
- `src/hooks/useKeyboardShortcuts.ts` owns viewer-wide shortcuts.
- `src/services/commandRegistry.ts` already contains command palette actions such as Reveal in
  Folder.
- Settings persistence already exists through `readSettings` and `writeSettings`.

## Implementation Steps

1. Add settings for external editor integration:
   - `externalEditorPath?: string`
   - optional `externalEditorLabel?: string` if the UI should display "Edit in Paint.NET" instead of
     a generic label.
2. Add settings UI:
   - browse for an executable on Windows.
   - allow clearing the configured editor.
   - explain that the selected app will receive the current image path as an argument.
3. Add a Tauri/frontend wrapper for launching a file with a chosen app:
   - prefer `@tauri-apps/plugin-opener` if it can open a path with a specific application.
   - if that is not reliable enough for the target platforms, add a narrow Rust command that
     launches the configured executable with the image path argument.
4. Add a viewer action such as `openCurrentImageInEditor(currentImagePath)`:
   - no-op when no current image is selected.
   - show a helpful error if no editor is configured.
   - show a clear error if launching the editor fails.
5. Add UI entry points:
   - top bar button or menu item labeled `Edit` or `Open in Editor`.
   - reuse `externalEditorLabel` if present for a friendlier label.
6. Add keyboard and command palette access:
   - choose a shortcut that does not conflict with existing rotate/copy/delete shortcuts.
   - add a command palette item like `Open current image in editor`.
7. Decide first-release refresh behavior:
   - manual refresh only is acceptable if task 22 exists and is sufficient.
   - if practical, prompt the user to refresh after returning from the editor when the file's
     modified time changes.
8. Keep the scope intentionally narrow:
   - launch only the current image in this task.
   - do not implement round-trip edit history, file watching, or multi-image batch editing here.

## Acceptance Criteria

- User can configure an external editor path in settings.
- User can open the current image in that editor from the viewer UI.
- If no editor is configured, LightFrame shows a clear actionable message instead of failing
  silently.
- Command palette entry works if the command palette feature is present.
- The feature does not block the viewer or crash if the editor process fails to launch.

## Tests

- Frontend tests for settings conversion and the viewer action error states.
- If a Rust command is added, Rust tests for invalid executable path and argument forwarding where
  practical.
- Command registry test for the new command entry.
- Run `pnpm test -- --run`.
- Run `pnpm build`.
- Run `cargo test` only if Rust launcher code is introduced.

## Reviewer Focus

- Confirm the configured executable path is validated enough to avoid confusing launch failures.
- Confirm file paths with spaces are passed correctly to the editor.
- Confirm the chosen shortcut does not conflict with existing viewer shortcuts.
- Confirm the implementation does not overreach into file-watching or edit-history scope.
