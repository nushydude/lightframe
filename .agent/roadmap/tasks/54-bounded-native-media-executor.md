# 54 - Bounded Native Media Executor

## Priority and Type

- Priority: P1
- Type: performance architecture and responsiveness
- Dependencies: task 53
- Expected branch: `codex/bounded-native-media-executor`
- Required final gate: `pnpm run ci:local`

## Goal

Replace independent, effectively uncancelable media `spawn_blocking` calls with one bounded native
executor that preserves interactive work under load, limits physical concurrency, coalesces
duplicate work, and supports meaningful cancellation.

## Current Code Context

- The frontend `imageWorkScheduler` prioritizes and limits requested work.
- Once a Rust blocking command starts, aborting the frontend consumer does not stop the physical
  decode.
- Preview, thumbnail, metadata, tile, and edit commands independently use
  `tauri::async_runtime::spawn_blocking`.
- Rapid navigation can leave stale native work consuming CPU after its result is no longer useful.

## Required Scheduling Model

Define native priority classes:

1. current-image preview.
2. current-image full detail/tile.
3. current-image metadata.
4. visible contact-sheet thumbnails.
5. directional adjacent preload.
6. background preload/cache maintenance.
7. explicit user edit/export jobs.

Explicit edits must be reliable and bounded but must not permanently starve current-image display.
Document the chosen fairness rule.

The executor must support:

- fixed total worker capacity.
- per-class concurrency caps or reserved capacity.
- FIFO ordering inside equal priority.
- duplicate-key coalescing for read-only generated assets.
- queued cancellation.
- cooperative cancellation checkpoints for running multi-stage work.
- stale generation/request rejection before committing generated cache output.
- queue and execution telemetry.

## Command and Request Requirements

- Every scheduled request carries an opaque request ID and optional generation token.
- Cancellation must be a real backend command or resource operation, not only a dropped JS promise.
- Read-only jobs may share one physical job with multiple consumers.
- Canceling one consumer must not cancel shared work still needed by another.
- Destructive/edit jobs must never be deduplicated solely by path.
- Completed cache writes must be atomic and valid even if the final consumer cancels after encoding.
- The executor must shut down cleanly when the app exits.

## Implementation Steps

1. Add a managed `MediaExecutor` state to the Tauri app.
2. Extract pure priority, capacity, deduplication-key, and fairness logic.
3. Migrate preview, thumbnail, tile, and metadata commands first.
4. Migrate crop, scale, rotate, and clipboard only after read-only scheduling tests pass.
5. Wire frontend abort signals to backend cancellation.
6. Reconcile existing frontend scheduler priorities with backend priorities in one mapping module.
7. Add telemetry:
   - queued and running by class.
   - canceled queued and canceled running.
   - coalesced consumers.
   - queue wait p50/p95/max.
   - execution duration p50/p95/max where the current telemetry model permits.
8. Expose only aggregated telemetry through diagnostics.
9. Keep cache maintenance on a low-priority path and prevent it from blocking visible work.

## Deterministic Tests

Use controllable test jobs with channels/barriers; do not rely on wall-clock races.

- Total running jobs never exceeds configured capacity.
- Interactive work starts ahead of queued background work.
- Background work eventually runs under sustained but bounded interactive traffic.
- Equal-priority jobs remain FIFO.
- Duplicate preview requests share one physical run.
- Canceling one shared consumer keeps the job alive for another.
- Canceling all queued consumers removes the job before execution.
- Canceling running work triggers checkpoints and prevents stale finalization where safe.
- Edit jobs are not deduplicated.
- Panics/errors free capacity and settle every consumer.
- Shutdown rejects new work and joins or safely abandons workers according to documented behavior.

## Frontend Tests

- Generation changes cancel obsolete native requests.
- Rapid next/previous navigation does not apply stale previews or metadata.
- Contact-sheet scrolling drops no-longer-visible queued thumbnails.
- Performance mode updates executor limits without violating absolute security ceilings.
- Diagnostics display native queue metrics without rerender loops.

## Performance Verification

Add a repeatable local benchmark or ignored Rust test using synthetic work:

- rapid navigation across at least 1,000 catalog entries.
- visible thumbnail burst plus current-image preview.
- cancellation storm.
- long edit job while navigating.

The benchmark records results; it must not assert unstable wall-clock thresholds in normal CI.

## Expected Files

- New executor modules in `src-tauri/src/`
- Tauri managed-state setup in `src-tauri/src/lib.rs`
- Media commands and telemetry
- `src/services/imageWorkScheduler.ts` mapping/cancellation integration
- Performance telemetry types and tests

## Validation Commands

```powershell
cargo test --manifest-path src-tauri/Cargo.toml media_executor
pnpm run test:run -- src/services/imageWorkScheduler.test.ts
pnpm run ci:local
```

## Acceptance Criteria

- Native media concurrency is globally bounded.
- Obsolete queued work is canceled in Rust.
- Running work checks cancellation where technically possible.
- Current-image work remains responsive during thumbnail/preload load.
- Duplicate generated-asset work is coalesced safely.
- Telemetry makes queue pressure and cancellation observable.
- Existing edit and cache safety guarantees remain intact.

## Reviewer Checklist

- Use deterministic concurrency tests.
- Reject a wrapper that still spawns unlimited blocking tasks.
- Review locks for deadlocks and lock-held I/O.
- Confirm cancellation cannot leave partial outputs or corrupt caches.
- Confirm fairness prevents background starvation without delaying current-image work.

