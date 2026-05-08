# 12 - Command Palette

## Roadmap Item

Command palette: add a fast keyboard-first way to trigger viewer actions without crowding the chrome.

## Goal

Add a lightweight command palette opened by keyboard shortcut that lists viewer actions and executes
them without adding more buttons to the chrome.

## Current Code Context

- Actions live across `ViewerChrome`, `useKeyboardShortcuts`, `viewerStore`, and `tauriCommands`.
- Existing shortcut for settings is Ctrl+Comma.
- No command registry exists.

## Implementation Steps

1. Create `src/services/commandRegistry.ts` or `src/state/commandRegistry.ts`.
2. Define a `ViewerCommand` type:
   - `id: string`
   - `label: string`
   - `keywords?: string[]`
   - `shortcut?: string`
   - `isEnabled(state): boolean`
   - `run(): void | Promise<void>`
3. Start with commands for existing actions:
   - open file
   - open folder
   - next image
   - previous image
   - first image
   - last image
   - toggle fullscreen
   - fit to screen
   - actual size
   - zoom in
   - zoom out
   - rotate left
   - rotate right
   - save rotation when available
   - toggle grid
   - toggle settings
   - reveal in folder
   - copy to clipboard
   - delete image
   - start slideshow
4. Add `src/components/CommandPalette.tsx`.
5. UI requirements:
   - modal overlay
   - search input focused on open
   - arrow key navigation
   - Enter runs active command
   - Escape closes
   - disabled commands hidden or visually disabled; prefer hidden for simplicity.
6. Add store state:
   - `showCommandPalette: boolean`
   - setter action.
7. Add keyboard shortcut:
   - Ctrl+K or Ctrl+Shift+P.
   - avoid interfering with browser default only inside app.
8. Render `CommandPalette` in `App.tsx` when open.
9. Make command registration practical:
   - simplest path: build commands in `App.tsx` using existing handlers and pass to palette.
   - avoid global mutable command registration unless needed.
10. Keep styling consistent with existing dark/light theme in `src/index.css`.

## Acceptance Criteria

- Ctrl+K opens the palette.
- Typing filters commands by label and keywords.
- Arrow keys and Enter work.
- Commands execute the same code paths as existing buttons/shortcuts.
- Palette closes after a command runs.
- It is accessible with `role="dialog"` and a labelled input.

## Tests

- Add `src/components/CommandPalette.test.tsx`.
- Test open rendering, filtering, keyboard movement, Enter execution, and Escape close.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm command actions are not duplicated inconsistently.
- Confirm palette does not capture shortcuts while typing elsewhere unless open.
- Confirm UI text fits and works in both themes.

