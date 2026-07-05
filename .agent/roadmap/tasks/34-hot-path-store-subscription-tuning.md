# 34 - Hot-Path Store Subscription Tuning

## Roadmap Item

Audit follow-up: reduce unnecessary React renders in image navigation, zoom, pan, and chrome update
paths.

## Goal

LightFrame should keep pointer-frequency interactions cheap. Panning, wheel zooming, and navigation
should update only the components that need those state changes, not the whole app shell or all
viewer chrome.

## Current Code Context

- `App`, `ImageCanvas`, `ViewerChrome`, `ThumbnailStrip`, `ContactSheet`, `CompareView`, and several
  hooks call `useViewerStore()` without a selector.
- `useZoomPan` writes `panX`, `panY`, and `zoomLevel` during mouse and wheel interactions.
- `App` also subscribes to `showControls` separately after already subscribing to the whole store.
- Zustand action access can use narrow selectors or `useViewerStore.getState()` for event-only
  actions.

## Implementation Steps

1. Inventory `useViewerStore()` calls outside tests and classify each as:
   - render data.
   - stable action.
   - event-only snapshot.
2. Replace full-store subscriptions in hot components with narrow selectors:
   - split primitive selectors where that keeps renders clear.
   - use shallow grouping only when it avoids noisy repeated selector calls.
   - prefer `useViewerStore.getState()` inside callbacks that do not need render subscriptions.
3. Pay special attention to panning and zooming:
   - `App` and `ViewerChrome` should not rerender just because `panX`, `panY`, or `zoomLevel`
     changes unless they render those fields.
   - keep transient drag state local where practical.
4. Remove duplicate subscriptions and stale destructuring.
5. Add or update tests that protect behavior after selector refactors.
6. If measurable render-count tests are practical, add a focused regression test for pan/zoom not
   rerendering unrelated chrome.

## Acceptance Criteria

- No hot-path component uses a broad `useViewerStore()` subscription without a documented reason.
- Panning and wheel zooming do not rerender `App` or `ViewerChrome` solely due to pan coordinate
  changes.
- Keyboard shortcuts, command palette enablement, crop mode, compare mode, thumbnails, and projector
  sync still behave as before.
- The implementation keeps existing Zustand patterns and does not introduce a new state library.

## Tests

- Run focused tests for touched components and hooks.
- Run `pnpm run lint`.
- Run `pnpm run test:run`.
- Run `pnpm run build`.

## Reviewer Focus

- Confirm selectors cover all render dependencies and do not create stale UI.
- Confirm event handlers still read fresh state where needed.
- Confirm render improvements target the actual pan/zoom/navigation hot path.
- Confirm the diff does not mix in visual redesign or unrelated refactors.
