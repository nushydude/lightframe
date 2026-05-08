# 22 - Refresh Current Folder

## Roadmap Item

Refresh current folder: add a refresh action that rescans the current folder, preserves the current
image when possible, and updates the viewer after files are added, removed, or renamed outside
LightFrame.

## Goal

Users should be able to manually refresh the current folder without reopening the folder or file.
Refresh should rescan the folder, reapply the active sort order, keep the current image selected if
it still exists, and move to a sensible nearby image if the current file was removed.

## Current Code Context

- `src/hooks/useImageNavigation.ts` already has `openImage`, `openFolder`, `scanFolder`, and local
  `sortImages`.
- `viewerStore` tracks `folderPath`, `images`, `currentImagePath`, `currentIndex`,
  `isFolderScanning`, and `loadGeneration`.
- `ViewerChrome` contains top-bar actions for open, reveal, copy, delete, grid, settings, etc.
- `useKeyboardShortcuts` owns global shortcuts.
- Future cache tasks may add image/thumbnail cache invalidation services; this task should use them
  if they exist.

## Implementation Steps

1. Add a `refreshFolder` function to `useImageNavigation`.
2. The function must:
   - return early with a clear error or no-op if `folderPath` is missing.
   - call `beginLoadGeneration()`.
   - set `isFolderScanning` true.
   - call `scanFolder(folderPath)`.
   - reapply the current `settings.sortOrder` using the same sort behavior as `openImage` and
     `openFolder`.
   - update `images`.
3. Preserve selection:
   - Save the previous `currentImagePath` and `currentIndex` before scanning.
   - If the previous path still exists in the refreshed list, select it.
   - If the previous path is gone, select the item at `min(previousIndex, refreshed.length - 1)`.
   - If the refreshed list is empty, reset image state enough to show an empty/error state.
4. Avoid duplicating sort logic if possible:
   - Extract `sortImages` from `useImageNavigation.ts` into a small exported helper such as
     `src/services/imageSorting.ts`.
   - Add focused tests for the helper if extracted.
5. Add cache handling:
   - If `thumbnailCache` or `imageAssetCache` services exist, trim/invalidate entries for paths not
     present in the refreshed folder.
   - If those services do not exist yet, leave a small integration point comment or no-op helper;
     do not build the entire cache system in this task.
6. Add UI:
   - Add a Refresh button to `ViewerChrome` near folder/navigation actions.
   - Use a concise label and accessible title, for example "Refresh folder".
   - Disable or hide it when there is no current folder.
7. Add keyboard shortcut:
   - Use `F5` only if slideshow start is moved elsewhere; currently `F5` starts slideshow.
   - Prefer `Ctrl+R` or `F6` to avoid conflicting with current slideshow behavior.
   - Prevent browser reload behavior for `Ctrl+R`.
8. If command palette exists, add a "Refresh current folder" command. If it does not exist, do not
   create command palette in this task.
9. Update loading feedback:
   - Existing `isFolderScanning` indicator in `ViewerChrome` should show while refresh is running.
   - Do not add a blocking modal.

## Acceptance Criteria

- User can refresh the current folder from the viewer UI.
- User can refresh with the keyboard shortcut.
- Added files appear after refresh.
- Removed files disappear after refresh.
- If the current image still exists, it remains selected.
- If the current image was removed, the viewer selects the nearest valid image.
- If no supported images remain, the app does not crash and shows a clear empty/error state.
- Active sort order is preserved after refresh.

## Tests

- Update or add tests for `useImageNavigation`:
  - refresh keeps current image when it still exists.
  - refresh selects nearest valid index when current image is removed.
  - refresh handles an empty folder.
  - refresh applies non-name sort order.
- If sorting is extracted, add tests for the sorting helper.
- Add keyboard shortcut test if existing shortcut tests make that practical.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm refresh uses the same generation/race protection as open image/folder.
- Confirm sort behavior is not duplicated inconsistently.
- Confirm current image selection is stable across added, removed, and renamed files.
- Confirm `Ctrl+R` or the chosen shortcut does not trigger browser reload.
- Confirm no unrelated cache architecture is introduced.

