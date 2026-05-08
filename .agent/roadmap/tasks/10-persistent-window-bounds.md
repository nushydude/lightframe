# 10 - Persistent Window Bounds

## Roadmap Item

Persistent window bounds: save and restore window size and position when the setting is enabled.

## Goal

When `rememberWindowBounds` is enabled, the main window should restore its last size and position on
startup and save updated bounds when the user moves or resizes it.

## Current Code Context

- `AppSettings.rememberWindowBounds` already exists.
- `SettingsPanel` exposes "Remember window size".
- Rust `AppSettings` does not include actual bounds fields.
- `src/App.tsx` already calls `getCurrentWindow()`.

## Implementation Steps

1. Extend frontend `AppSettings` with optional bounds fields:
   - `windowX?: number`
   - `windowY?: number`
   - `windowWidth?: number`
   - `windowHeight?: number`
2. Extend Rust `AppSettings` with matching snake_case optional fields and `serde(default)`.
3. Update `settingsToRust` and `settingsFromRust`.
4. In `App.tsx`, after settings are loaded and before showing the main window when possible:
   - if `rememberWindowBounds` is true and all bounds are present, call Tauri window APIs to set
     position and size.
5. Use Tauri v2 logical or physical types consistently:
   - import `LogicalPosition` and `LogicalSize` if needed.
   - do not mix logical and physical units.
6. Add listeners for window moved and resized events:
   - debounce writes by about 500 ms.
   - save only when `rememberWindowBounds` is true.
   - save only for main window, not secondary projector window.
7. Avoid saving minimized or fullscreen bounds:
   - skip saves while fullscreen.
   - if an API exposes minimized state, skip minimized too.
8. If setting is turned off, stop writing bounds. Do not delete old bounds unless specified.

## Acceptance Criteria

- With setting enabled, app restores the previous main window size and position.
- With setting disabled, app uses configured/default Tauri window bounds.
- Fullscreen bounds are not persisted as normal window bounds.
- Existing settings files without bounds still parse correctly.

## Tests

- Add tests for `settingsFromRust` and `settingsToRust` optional bounds fields.
- If window logic is extracted into a helper, test helper conditions.
- Run `pnpm test -- --run`.
- Run `pnpm build`.
- Run `cargo test` because Rust settings changed.

## Reviewer Focus

- Confirm backwards compatibility for existing settings JSON.
- Confirm bounds are saved only for the main window.
- Confirm write debounce prevents excessive disk writes.

