# 47 - Keyboard-Accessible Thumbnail and Contact Sheet Collections

## Priority and Type

- Priority: P1
- Type: accessibility and interaction bug fix
- Dependencies: implement after task 45; coordinate with task 46 if both touch ContactSheet

## Problems

- Thumbnail-strip items are clickable `<div>` elements with no focus or activation semantics.
- Contact-sheet items are clickable `<div>` elements with no focus or accessible name.
- ContactSheet's window-level key handler exits the grid on every Enter key press, including Enter
  pressed on toolbar buttons or future search inputs.
- Focus is not moved with the active image, so sighted keyboard users can lose their place in a
  virtualized collection.

## Goal

Make both image collections operable and understandable by keyboard and assistive technology while
preserving existing global image-navigation shortcuts.

## Required Semantics

### Thumbnail Strip

- Container role: `listbox`, accessible label `Folder images`.
- Each visible thumbnail: native `button` with `role="option"`.
- Accessible name: the image filename.
- `aria-selected="true"` only for the current image.
- Use roving tab index: current thumbnail is `tabIndex=0`; other thumbnails are `tabIndex=-1`.
- Enter or Space activates the focused thumbnail through native button behavior.
- Left/Right on a focused thumbnail moves the current image by one and focuses the newly active
  thumbnail after it renders.
- Home/End on a focused thumbnail selects and focuses first/last.

### Contact Sheet

- Grid container role: `grid`, accessible label `Folder contact sheet`.
- Each image item: native `button` with `role="gridcell"` and accessible filename.
- `aria-selected` reflects the path-based bulk selection state, not merely current image state.
- Current-image state must also remain visually distinct. Add `aria-current="true"` to the current
  image.
- Use roving tab index with the current image as the tab stop.
- Arrow keys retain existing row/column navigation and focus the newly current cell.
- Home/End select and focus first/last.
- Enter opens the focused image in viewer mode only when focus is on a grid cell.
- Space toggles the focused image in `selectedPaths` without exiting grid.
- Shift+Arrow extends selection from the selection anchor through the destination in displayed grid
  order.

## Interactive-Target Guard

Before processing a contact-sheet global shortcut, inspect `event.target`.

Do not process grid navigation, Enter-to-open, Space-to-select, Delete, or Home/End when the target
is an input, select, textarea, button outside the grid, link, or element with editable content.
Escape may still close open menus according to their existing behavior. This guard must be a small
testable helper rather than a growing inline condition.

## Virtualization and Focus

- Never call `.focus()` for an item that is not rendered.
- Navigation first updates `currentIndex`; existing scroll synchronization brings the item into the
  virtual window; a layout effect then focuses the button whose path matches the new current path.
- Do not disable virtualization or render the whole folder to solve focus.
- When an image disappears after watcher/filter/search changes, focus the reconciled current image.

## Files Expected to Change

- `src/components/ThumbnailStrip.tsx`
- `src/components/ThumbnailConsumers.test.tsx` and/or a focused ThumbnailStrip test
- `src/components/ContactSheet.tsx`
- `src/components/ContactSheet.test.tsx`
- `src/index.css` for button reset and `:focus-visible` styles
- A small keyboard-target helper and test if useful

## Required Tests

- Thumbnail container/item roles, names, selected state, and roving tab index.
- Thumbnail Enter/Space activation and Left/Right/Home/End behavior.
- Contact-sheet grid/cell roles, names, current state, selection state, and roving tab index.
- Contact-sheet arrows move by one or by current column count.
- Contact-sheet Enter opens only when focus is on a grid cell.
- Enter on Open Folder, Settings, More Actions, and any input does not exit grid.
- Space toggles selection without exiting grid.
- Shift+Arrow extends displayed-order selection.
- Focus follows a newly virtualized active item without rendering all items.
- Visible focus styles exist in dark and light themes.

## Acceptance Criteria

- Every visible thumbnail and grid image is reachable and named for assistive technology.
- A keyboard-only user can move, open, select, and reach first/last images.
- Toolbar button and input keystrokes are not stolen by the grid handler.
- Virtualization and pointer multi-selection behavior remain intact.
- No duplicate document-level keyboard listeners are introduced.

## Validation Commands

```powershell
pnpm run test:run -- src/components/ThumbnailConsumers.test.tsx src/components/ContactSheet.test.tsx src/hooks/useKeyboardShortcuts.test.ts
pnpm run test:run
pnpm run build
```

## Non-Goals

- No screen-reader-specific dependency.
- No contact-sheet redesign.
- No removal of global viewer shortcuts.
- No disabling virtualization.
