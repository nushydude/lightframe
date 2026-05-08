# 17 - Edit History Per Image

## Roadmap Item

Edit history per image: track pending rotate/crop changes before committing them to disk.

## Goal

Rotation and crop changes should become pending per-image edits that can be reviewed, undone, reset,
or committed instead of immediately existing as scattered store fields.

## Current Code Context

- `viewerStore.rotation` stores pending rotation globally for the current image.
- Crop tasks add crop state.
- `saveRotation` writes the current rotation directly.
- Navigation resets rotation to zero.

## Implementation Steps

1. Define edit types in `viewerStore` or `src/types/edit.ts`:
   - `PendingImageEdit`
   - `rotationDegrees: number`
   - `cropRect?: NormalizedCropRect`
   - `updatedAt: number`
2. Store pending edits by image path:
   - `pendingEditsByPath: Record<string, PendingImageEdit>`
3. Replace global `rotation` source of truth:
   - keep selector/action compatibility if helpful.
   - `rotation` can derive from current image pending edit.
4. Actions:
   - `rotateClockwise`
   - `rotateCounterClockwise`
   - `setPendingCrop`
   - `clearPendingEdits(path)`
   - `clearAllPendingEdits`
   - `commitPendingEdits(path)`
   - `undoLastEdit(path)` if history stack is implemented.
5. For low risk, implement per-image pending state first, then history stack:
   - Each path keeps `history: PendingImageEditSnapshot[]`.
   - Push previous snapshot before each edit.
6. Navigation should preserve pending edits for other images and apply pending edit display when
   returning to an image.
7. Add UI indication in chrome:
   - show an unsaved/pending edit state when current image has pending edits.
   - provide Reset and Save actions.
8. Commit flow:
   - if only rotation exists, call existing save rotation command.
   - if crop exists, call crop overwrite or save-copy flow depending on available tasks.
   - after successful commit, invalidate caches and clear pending edits for that path.
9. Avoid persisting edit history across app restarts in this task unless explicitly requested.

## Acceptance Criteria

- Pending rotation is tracked per image.
- Navigating away and back restores that image's pending rotation/crop preview.
- Reset clears pending edits for current image only.
- Commit clears pending edits only after disk operation succeeds.
- Existing rotate shortcuts still work.

## Tests

- Add store tests for per-image edit persistence across navigation.
- Test reset current image vs reset all.
- Test commit success clears edits and failure keeps edits.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm no pending edit is lost on simple navigation.
- Confirm save failures do not clear pending edits.
- Confirm UI makes unsaved state visible without crowding chrome.

