# Native media scheduling

All preview, thumbnail, tile, metadata, clipboard and edit commands use one managed
`MediaExecutor`. Its four fixed threads admit 2/3/4 concurrent jobs in Low Memory,
Balanced and Fast modes. A lower requested capacity drains existing work before
admitting more. Task 53's per-operation byte/pixel ceilings remain unchanged.

Priority order is preview, full detail/tile, metadata, visible thumbnails,
directional preload, background/maintenance, then explicit edits. Equal priorities
dispatch FIFO. Each eighth dispatch selects the oldest eligible job regardless of
priority, preventing starvation under bounded traffic. Class caps are respectively
2, 2, 1, 2, 1, 1 and 1. Noninteractive work together can occupy at most capacity
minus one slots, reserving a slot for current-image work even during an edit.
There are at most 256 queued physical jobs and 1,024 consumers; 16 queue places are
reserved for interactive requests. Overflow rejects a request explicitly.

Every invocation has an opaque request ID and optional generation token. Read-only
generated assets coalesce by command, arguments, cache epoch and generation. A
shared job retains independent consumers; removing its final consumer cancels it.
Edits never coalesce. Abort signals issue `cancel_media_request`; late responses are
also rejected by the frontend. Short, bounded prearrival cancellation history
handles cancellation arriving before command admission.

Workers check cancellation between codec stages and before publication. A codec
call already inside a native library cannot be forcibly interrupted, so physical
capacity remains occupied until it returns. Edit replacement, once begun, finishes
atomically. Generated output is staged and only published after cancellation,
source-version and root-epoch validation. Thumbnail, preview and tile jobs capture
their root generation before queue admission, so work dispatched after a clear
cannot adopt the replacement namespace or return a retired cache hit. Clearing a
cache retires its namespace while scanning and removing files outside the root
lock; stale producers cannot write back. Tile source memory has its own retirement
epoch. Maintenance uses the
same pool at background priority and retries on later cache access after overload.

Application exit rejects queued/new requests and signals running jobs. Fixed worker
threads may finish with their owned state after shutdown; the app does not block
exit indefinitely on an uninterruptible codec. No new threads are spawned per job.

Diagnostics expose only aggregate class counts, cancellation/coalescing counts,
and queue/execution p50, p95 and max milliseconds over the latest 512 samples.
No request IDs or paths are included in these executor metrics.

Run the deterministic scheduling tests with:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml media_executor
```

Run the synthetic 1,000-entry navigation, thumbnail burst, cancellation storm and
concurrent edit benchmark with:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml media_executor_navigation_benchmark -- --ignored --nocapture
```

The benchmark prints elapsed time and aggregate telemetry; normal CI asserts no
wall-clock performance thresholds.
