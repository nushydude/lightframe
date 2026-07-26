# 54 - Background Generated Cache Maintenance

## Priority and Type

- Priority: P1
- Type: native I/O performance
- Dependency: follow-up to task 03

## Goal

Move generated thumbnail, preview, and tile cache eviction off foreground asset requests and avoid a
full directory scan on a fixed request cadence.

## Current Evidence

- `src-tauri/src/thumbnails.rs` caps a cache root at 2,000 entries and 256 MiB.
- `ensure_cache_root` calls `maybe_cleanup_cache`; every 32nd request synchronously invokes
  `cleanup_cache_best_effort`.
- Cleanup reads the full directory, canonicalizes and stats every generated file, accumulates all
  entries, sorts them by modification time, and deletes oldest entries.
- Work happens inside the blocking worker serving the foreground asset, increasing queue occupancy
  and response latency as the cache grows.

## Required Design

1. Add one process-wide cache-maintenance coordinator that schedules at most one cleanup per cache
   root at a time.
2. Foreground requests may signal maintenance but must not wait for a full eviction scan.
3. Track inexpensive approximate entry/byte deltas on successful writes and trigger maintenance
   only when a limit may be exceeded or metadata is unavailable.
4. Keep a startup or explicit-reconciliation path for rebuilding accounting after crashes and manual
   cache changes.
5. Preserve redirect/symlink protections and constrain every deletion to a verified cache root.
6. Define shutdown behavior; abandoned best-effort maintenance must not delay app exit or corrupt
   generated files.

## Acceptance Criteria

- The foreground cache-hit/miss path never performs a full cleanup scan inline.
- Concurrent threshold crossings schedule one cleanup, not one per request.
- Count and byte limits are restored after asynchronous maintenance.
- Accounting recovers after restart and tolerates missing or externally removed entries.
- Cleanup cannot inspect or delete outside the intended generated cache root.

## Required Tests and Validation

- Use barriers/channels to prove an asset request returns without waiting for a blocked cleanup.
- Test coalescing, threshold crossing, restart reconciliation, partial metadata failure, and
  redirected cache roots.
- Assert scan invocation counts and final entry/byte bounds; do not use elapsed-time thresholds.
- Run focused thumbnail/cache Rust tests.
- Run `pnpm run ci:rust`.

## Non-Goals

- No cache format change.
- No user-facing cache-size setting.

## Reviewer Checklist

- Confirm request workers do not synchronously own maintenance.
- Confirm approximate accounting cannot permanently bypass limits.
- Confirm filesystem containment checks survive the refactor.
