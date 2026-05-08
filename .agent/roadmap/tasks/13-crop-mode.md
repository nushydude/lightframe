# 13 - Crop Mode

## Roadmap Item

Crop mode: add an interactive crop overlay with aspect ratio presets, keyboard nudging, and
non-destructive preview.

## Goal

Users should be able to enter crop mode, adjust a crop rectangle visually, choose aspect ratio
presets, nudge the crop with the keyboard, and preview the crop without changing the source file.

## Current Code Context

- `ImageCanvas` renders an `<img>` with transforms for zoom, pan, fit/fill/actual, and rotation.
- `viewerStore` stores rotation and zoom state but no edit state.
- `ViewerChrome` contains rotate and save rotation controls.
- No crop UI or Rust crop command exists yet.

## Implementation Steps

1. Add crop state to `viewerStore`:
   - `isCropMode: boolean`
   - `cropRect: { x: number; y: number; width: number; height: number } | null`
   - `cropAspectRatio: 'free' | '1:1' | '4:3' | '3:2' | '16:9'`
   - actions to enter, exit, update rect, set aspect ratio, reset crop.
2. Store crop rect in normalized image coordinates from 0 to 1. Do not store screen pixels as the
   source of truth.
3. Create `src/components/CropOverlay.tsx`.
4. Render the overlay inside `ImageCanvas` above the image only when crop mode is active.
5. Compute displayed image bounds:
   - use the actual rendered `<img>` bounding client rect.
   - account for fit/fill/actual/custom modes enough for the overlay to align.
   - if rotation makes this too complex, disable crop while rotation preview is non-zero and show a
     clear inline control state.
6. Overlay interactions:
   - drag inside rect moves it.
   - drag handles resize it.
   - hold Shift optionally locks current ratio.
   - clamp crop rect to image bounds.
7. Add aspect ratio preset controls in `ViewerChrome` or a small crop toolbar.
8. Add keyboard support while crop mode is active:
   - Arrow keys nudge 1 px equivalent.
   - Shift+Arrow nudges 10 px equivalent.
   - Enter applies preview mode or confirms selection.
   - Escape exits crop mode without saving.
9. Non-destructive preview:
   - after user presses preview/apply, keep source file unchanged.
   - render image clipped to crop rect or set a `pendingCropPreview` state.
10. Add a Crop button to chrome and a command palette entry if task 12 exists.

## Acceptance Criteria

- User can enter and exit crop mode.
- Crop rect is visible, draggable, resizable, and clamped to image bounds.
- Aspect presets constrain resizing.
- Keyboard nudging works.
- No source file is modified.
- Existing navigation exits or clears crop mode safely.

## Tests

- Add store tests for crop state actions and clamping helpers.
- Extract crop math into `src/services/cropMath.ts` and test:
  - normalized to pixel conversion
  - clamping
  - aspect ratio resize behavior
  - keyboard nudging.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm crop math is pure and tested.
- Confirm source files are not modified.
- Confirm overlay alignment remains acceptable across fit/fill/actual modes.

