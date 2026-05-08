# 09 - Mouse Wheel Navigation

## Roadmap Item

Mouse wheel navigation: fully implement the existing "navigate" wheel mode setting.

## Goal

When `settings.mouseWheelBehavior` is `navigate`, mouse wheel movement over the image should move to
the previous or next image instead of zooming.

## Current Code Context

- `src/types/settings.ts` already defines `mouseWheelBehavior: 'zoom' | 'navigate'`.
- `SettingsPanel` already exposes the setting.
- `src/hooks/useZoomPan.ts` handles wheel zoom and has a comment saying navigate mode is handled
  elsewhere, but it is not implemented.
- `App.tsx` owns `goNext` and `goPrev` from `useImageNavigation`.

## Implementation Steps

1. Extend `useZoomPan` to accept optional navigation callbacks:
   - `onWheelNext?: () => void`
   - `onWheelPrev?: () => void`
2. Update `ImageCanvas` props to accept those callbacks.
3. Pass `goNext` and `goPrev` from `App.tsx` into `ImageCanvas` for the main viewer.
4. For secondary windows, pass no callbacks or disabled callbacks so projector windows do not
   navigate independently unless explicitly desired.
5. In `useZoomPan.handleWheel`:
   - if behavior is `zoom`, keep existing zoom behavior.
   - if behavior is `navigate`, use `e.deltaY`.
   - `deltaY > 0` should go next.
   - `deltaY < 0` should go previous.
6. Add wheel throttling so one physical wheel gesture does not skip many images:
   - store `lastWheelNavigationAt` in a ref.
   - ignore navigation events within 180 ms to 250 ms.
   - allow trackpads to work without runaway navigation.
7. Do not navigate on mostly horizontal scroll:
   - if `Math.abs(e.deltaX) > Math.abs(e.deltaY)`, ignore.
8. Keep `preventDefault()` so the page does not scroll.

## Acceptance Criteria

- Mouse wheel in zoom mode still zooms.
- Mouse wheel in navigate mode moves next/previous by one image per throttled gesture.
- Boundary behavior matches arrow navigation, including the existing boundary beep from `goNext` and
  `goPrev`.
- Grid/contact sheet wheel scrolling still scrolls the grid; only the image canvas consumes wheel
  navigation.

## Tests

- Add or update `src/hooks/useZoomPan.test.ts`.
- Mock callbacks and dispatch wheel events:
  - zoom mode calls `setZoomLevel`
  - navigate mode calls next/prev
  - horizontal wheel does not call navigation
  - throttle prevents repeated rapid calls.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm wheel event listener is cleaned up.
- Confirm contact sheet scrolling is not broken.
- Confirm trackpad users do not skip many images accidentally.

