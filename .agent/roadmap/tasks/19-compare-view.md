# 19 - Compare View

## Roadmap Item

Compare view: show two images side by side for picking the sharper or better shot.

## Goal

Add a mode that displays the current image and another candidate image side by side, with keyboard
navigation to choose the better image or move candidates.

## Current Code Context

- `viewerStore.viewMode` currently supports `'viewer' | 'grid'`.
- `ImageCanvas` is built for one current image.
- Contact sheet can select images by index.

## Implementation Steps

1. Extend `viewMode` to include `'compare'`.
2. Add compare state to `viewerStore`:
   - `comparePrimaryIndex`
   - `compareSecondaryIndex`
   - `compareFocusedPane: 'primary' | 'secondary'`
3. When entering compare mode:
   - primary defaults to current index.
   - secondary defaults to next image if available, otherwise previous.
4. Create `src/components/CompareView.tsx`.
5. Compare view layout:
   - two equal panes.
   - each pane displays file name, index, and image.
   - use existing `convertFileSrc` or image asset cache.
   - do not duplicate all `ImageCanvas` zoom/pan complexity at first.
6. Add controls:
   - left/right changes focused pane candidate.
   - Tab switches focused pane.
   - Enter makes focused pane the primary/current image and returns to viewer or keeps compare mode,
     choose one and document it. Prefer keep compare mode for curation.
   - Escape exits compare mode.
7. Add chrome button and command palette action if available.
8. Add optional favorite/rating integration if task 18 exists, but do not require it.
9. Ensure secondary image paths are valid if images array changes.

## Acceptance Criteria

- Compare mode opens with two different images when folder has at least two images.
- User can change the compared image with keyboard.
- Focused pane is visually clear.
- Exiting compare mode returns to normal viewer with a valid current image.
- Single-image folders do not enter compare mode and show a clear disabled state.

## Tests

- Add store tests for compare mode initialization and candidate navigation.
- Add component test for rendering two panes and keyboard interactions.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm compare state cannot point outside `images`.
- Confirm keyboard handling does not conflict with global viewer shortcuts.
- Confirm large images do not load more full-resolution assets than necessary.

