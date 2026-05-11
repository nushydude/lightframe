# 24 - Performance Telemetry Overlay

## Roadmap Item

Performance telemetry overlay: measure startup, navigation, decode, render, cache, and thumbnail
queue timings so every performance change can be validated with numbers.

## Goal

LightFrame should have an opt-in developer overlay that makes performance visible while using the
app normally. The overlay should be cheap enough to leave enabled during profiling and precise
enough to compare before and after results for roadmap performance work.

## Current Code Context

- `src/components/ImageCanvas.tsx` owns preview-first loading, full-resolution loading, and adjacent
  preload timing.
- `src/hooks/useImageNavigation.ts` owns open image, startup image, open folder, and refresh folder
  flows.
- `src/services/thumbnailCache.ts` owns thumbnail queueing, concurrency, cache hits, and cache
  eviction.
- `src/services/imageAssetCache.ts` owns preview and full asset cache state.
- `src-tauri/src/commands.rs` uses blocking workers for scan, preview generation, thumbnails, EXIF,
  clipboard, rotation, and crop operations.

## Implementation Steps

1. Add a small telemetry service in `src/services/performanceTelemetry.ts`:
   - timestamped spans.
   - counters.
   - rolling latency summaries.
   - a no-op mode when disabled.
2. Add event points for user-visible latency:
   - app start to first image path known.
   - image path selected to first preview visible.
   - image path selected to full-resolution ready.
   - next/previous keydown to visible image source update.
   - folder open to first image visible.
3. Add event points for background work:
   - folder scan duration.
   - preview generation duration.
   - thumbnail queue depth and in-flight count.
   - thumbnail cache hits and misses.
   - image asset cache hits and misses.
4. Add a compact overlay component:
   - hidden by default.
   - toggle from command palette and a dev-friendly shortcut such as `Ctrl+Shift+F12`.
   - show current image timings, rolling p50/p95, cache hit rates, queue depth, and approximate
     cache entry counts.
5. Keep overhead low:
   - avoid rendering the overlay on every metric write.
   - batch UI updates with `requestAnimationFrame` or a short interval.
   - do not retain unbounded event history.
6. Add Rust timing only where it materially helps:
   - either return timing metadata from existing commands in a later task.
   - or log spans through a narrow Tauri event if the overhead is acceptable.
   - start with frontend wrapper timing if that is enough.

## Acceptance Criteria

- Overlay can be toggled without affecting normal users.
- Open-to-preview and open-to-full-resolution timings are visible.
- Thumbnail queue depth and in-flight counts are visible.
- Cache hit/miss rates are visible for thumbnails and preview/full image assets.
- Metrics reset cleanly when requested.
- Enabling the overlay does not noticeably slow rapid navigation.

## Tests

- Unit tests for telemetry span lifecycle and rolling summaries.
- Unit tests for bounded history retention.
- Component test for overlay rendering from supplied telemetry snapshots.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm instrumentation does not add significant work on every render.
- Confirm metric state is bounded and cannot grow with long sessions.
- Confirm timing names are stable enough to compare across future PRs.
- Confirm the overlay is hidden from normal users by default.
