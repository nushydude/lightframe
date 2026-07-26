# 50 - Scheduler Running-Work Capacity Accounting

## Priority and Type

- Priority: P1
- Type: performance correctness
- Dependency: follow-up to task 26

## Goal

Keep image-work concurrency bounded until the underlying operation actually settles, even after its
last frontend consumer is canceled.

## Current Evidence

- `src/services/imageWorkScheduler.ts` removes a running job from `jobsByKey`, marks it settled, and
  calls `pump()` when its last consumer is canceled.
- Scheduler capacity is derived from jobs still recorded as running, so cancellation immediately
  admits replacement work.
- `get_preview_image` and `get_image_tile` in `src-tauri/src/commands.rs` run decode work through
  `tauri::async_runtime::spawn_blocking`. Aborting the JavaScript consumer does not stop that native
  closure.
- The test named `frees an interactive slot when running work loses its last consumer` currently
  codifies the unsafe early-release behavior.

## Required Design

1. Separate consumer settlement from physical worker settlement.
2. Cancel consumers immediately and abort cooperative JavaScript work, but retain a tombstoned
   running job in scheduler capacity accounting until `run()` fulfills or rejects.
3. Remove the tombstone from deduplication so a new request can be queued, while preventing it from
   starting beyond the configured global and priority limits.
4. Ensure a late completion cannot resolve canceled consumers, overwrite current state, or remove a
   newer job with the same key.
5. Expose canceled-but-still-running work in scheduler snapshots so concurrency assertions and
   telemetry remain truthful.

## Acceptance Criteria

- Canceling the last consumer rejects that consumer promptly.
- Replacement work does not start until the non-cooperative running promise settles when the
  concurrency limit is one.
- Cooperative aborts may release capacity only after their promise settles.
- Dedupe, priority promotion, queued cancellation, and stale-response protection remain intact.
- Scheduler counters never under-report physical work that is still executing.

## Required Tests and Validation

- Replace the early-slot-release test with a deferred non-cooperative job test.
- Add a cooperative-abort test and a same-key reschedule/tombstone test.
- Assert start order and snapshot counts with deferred promises, not elapsed time.
- Run `pnpm run test:run -- src/services/imageWorkScheduler.test.ts`.
- Run `pnpm run ci:frontend`.

## Non-Goals

- Do not add native decode cancellation in this task.
- Do not change the priority policy introduced by task 26.

## Reviewer Checklist

- Confirm every capacity counter follows worker settlement rather than consumer count.
- Confirm canceled consumers cannot receive late results.
- Confirm a same-key late completion cannot delete or settle replacement work.
