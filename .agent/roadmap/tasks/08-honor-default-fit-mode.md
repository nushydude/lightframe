# 08 - Honor Default Fit Mode

## Roadmap Item

Honor default fit mode: apply the saved default fit/fill/actual setting whenever a new image opens.

## Goal

When the user has selected a default fit mode in settings, every newly opened or navigated image
should start in that mode instead of always resetting to `fit`.

## Current Code Context

- `AppSettings.defaultFitMode` already exists in `src/types/settings.ts`.
- `SettingsPanel` already exposes "Default image fit".
- `viewerStore.setCurrentImage`, `setCurrentIndex`, and `resetZoom` currently hard-code `zoomMode:
  'fit'`.
- Store actions do not currently read settings.

## Implementation Steps

1. Avoid importing `settingsStore` inside `viewerStore` if it creates awkward coupling.
2. Add a store action in `viewerStore`:
   - `setDefaultZoomMode(mode: ZoomMode): void`
   - store field `defaultZoomMode: ZoomMode`
3. Initialize `defaultZoomMode` to `'fit'`.
4. Update `setCurrentImage` and `setCurrentIndex` to reset `zoomMode` to `get().defaultZoomMode`.
5. Leave `resetZoom()` as explicit "fit to screen" unless UX requires otherwise. Keyboard `0` should
   still mean fit.
6. In `App.tsx`, after settings load or when `settings.defaultFitMode` changes, call
   `setDefaultZoomMode(settings.defaultFitMode)`.
7. Ensure `fill` and `actual` are valid `ZoomMode` values and no TypeScript casts hide errors.
8. Update tests in `src/state/viewerStore.test.ts`.

## Acceptance Criteria

- Setting default image fit to `fill` makes newly navigated images open in fill mode.
- Setting default image fit to `actual` makes newly navigated images open at actual size.
- Pressing `0` still switches to fit.
- Ctrl+0 reset behavior remains fit.
- Existing persisted settings format remains unchanged.

## Tests

- Add store tests:
  - default zoom mode starts as `fit`
  - `setDefaultZoomMode('fill')` affects `setCurrentImage`
  - `setDefaultZoomMode('actual')` affects `setCurrentIndex`
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm no cyclic import between stores.
- Confirm default fit setting applies only to new image opens, not every settings panel change on the
  current image unless explicitly intended.

