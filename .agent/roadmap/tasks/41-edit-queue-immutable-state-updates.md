# 41 - Edit Queue Immutable State Updates

## Roadmap Item

Audit follow-up: remove in-place Zustand state mutation from the background edit queue.

## Goal

The edit queue should update jobs immutably so UI subscribers do not rely on a separate
`jobsVersion` invalidation field. This makes queue behavior easier to reason about and safer to
extend.

## Current Code Context

- `editQueueStore` mutates job objects in place with `Object.assign`.
- `EditQueuePanel` subscribes to `jobsVersion` only to force rerenders after in-place mutation.
- The queue is already virtualized, so immutable array updates should stay cheap enough for normal
  queue sizes.
- Duplicate output path checks and summary counts are maintained manually.

## Implementation Steps

1. Replace in-place job mutation helpers with immutable helpers that return updated job arrays and a
   success flag.
2. Remove `jobsVersion` from the store if it becomes unnecessary.
3. Update `EditQueuePanel` to subscribe only to state it renders.
4. Preserve queue drain semantics:
   - queued to running.
   - running to completed or failed.
   - retry failed/canceled.
   - cancel queued.
   - clear finished.
5. Add tests that would fail if job object identity changes are not propagated to subscribers.

## Acceptance Criteria

- `editQueueStore` no longer mutates `state.jobs` or job objects in place.
- `EditQueuePanel` does not need a dummy version subscription to rerender.
- Queue summaries remain correct after enqueue, run, fail, retry, cancel, clear, and reset.
- Existing edit queue UI behavior is unchanged.

## Tests

- Run `pnpm run test:run -- src/state/editQueueStore.test.ts`.
- Add or update tests for immutable subscriber-visible updates.
- Run `pnpm run test:run`.
- Run `pnpm run build`.

## Reviewer Focus

- Confirm no in-place mutation remains in the edit queue store.
- Confirm summary counts cannot drift from job statuses.
- Confirm the queue drain loop still handles pause/reset generation safely.
- Confirm UI virtualization still receives updated job rows.
