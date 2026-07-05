# 36 - Slideshow Large-Folder Reconciliation

## Roadmap Item

Audit follow-up: remove avoidable full-list work from slideshow render and shuffle reconciliation.

## Goal

Slideshow logic should not perform O(n) path mapping and string joining during unrelated renders,
and shuffle reconciliation should not become quadratic for large folders.

## Current Code Context

- `useSlideshow` subscribes to the whole viewer store.
- `previousImagePathsRef` and `imageOrderSignature` are built from `images.map(...)`.
- `imageOrderSignature` joins every image path during render.
- Reconciliation maps paths back to indexes with repeated `indexOf` calls.

## Implementation Steps

1. Replace broad store subscription with narrow selectors for slideshow fields and actions.
2. Introduce a viewer-store image list revision or equivalent stable signal that changes only when
   image ordering/content changes.
3. Replace `imageOrderSignature` string joins with the revision signal.
4. During shuffle reconciliation, build a single `Map<string, number>` for the next image paths and
   use it for path-to-index conversion.
5. Keep shuffle semantics:
   - current image stays first after folder changes.
   - already-seen images stay skipped where possible.
   - newly added images enter the remaining shuffled pool.
6. Add tests that exercise large-list reconciliation behavior without relying on timing.

## Acceptance Criteria

- `useSlideshow` no longer maps and joins every image path during normal render.
- Shuffle reconciliation is O(n) for list changes, not O(n^2).
- Slideshow start, pause, loop, shuffle, fullscreen, and folder-change behavior remain unchanged.
- The implementation does not introduce visible UI changes.

## Tests

- Run `pnpm run test:run -- src/hooks/useSlideshow.test.ts`.
- Add or update tests for shuffle order reconciliation after image add/remove/reorder.
- Run `pnpm run test:run`.
- Run `pnpm run build`.

## Reviewer Focus

- Confirm the new revision signal updates on every image-list mutation that matters.
- Confirm current index refs remain fresh during timer callbacks.
- Confirm no stale closure is introduced around slideshow settings.
- Confirm large-list improvements are covered by a focused regression test.
