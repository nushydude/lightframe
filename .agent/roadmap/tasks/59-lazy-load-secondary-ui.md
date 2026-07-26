# 59 - Lazy-Load Secondary Interface Surfaces

## Priority and Type

- Priority: P2
- Type: startup and bundle performance
- Dependency: coordinate component boundaries with task 57

## Goal

Keep infrequently opened panels and overlays out of the initial JavaScript chunk so normal image
startup parses and evaluates only the primary viewer path.

## Current Evidence

- `src/App.tsx` statically imports `SettingsPanel`, `CommandPalette`,
  `PerformanceTelemetryOverlay`, `ContactSheet`, and `CompareView`.
- Most of these surfaces are conditionally rendered only after a user action or mode change.
- The audit production build emitted an application chunk of about 489.83 KiB raw / 140.33 KiB
  gzip, with no deliberate route or component split for these secondary surfaces.

## Required Design

1. Capture a Vite manifest or equivalent module-to-chunk report as the deterministic baseline.
2. Lazy-load Settings, Command Palette, Performance Telemetry, Contact Sheet, and Compare View where
   dependency analysis confirms they are not required for initial startup.
3. Use focused `Suspense` boundaries whose fallback does not replace or flash the entire viewer.
4. Preserve keyboard-command behavior while a chunk is loading and prevent duplicate open actions.
5. Handle chunk-load failure with an accessible recoverable message instead of a blank surface.
6. Optionally prefetch a secondary chunk after initial image readiness or on strong user intent; do
   not make prefetch part of the startup critical path.

## Acceptance Criteria

- The initial application chunk no longer contains the implementation modules for the agreed
  secondary surfaces.
- Startup behavior and the first image path do not wait on those chunks.
- Each surface opens correctly on first and subsequent use, including via keyboard shortcuts.
- Loading and failure states are localized, accessible, and recoverable.
- The main entry chunk does not grow; record raw and gzip chunk sizes as evidence, not a brittle
  pass/fail timing threshold.

## Required Tests and Validation

- Add component tests for loading, success, rejected import, retry, and repeated open/close.
- Build with manifest output and assert secondary modules map to separate chunks.
- Run the production build and compare the chunk report to the checked baseline.
- Run `pnpm run ci:frontend`.

## Non-Goals

- No router introduction.
- No visual redesign of secondary surfaces.
- No wall-clock startup assertion in CI.

## Reviewer Checklist

- Confirm imports are actually split in production output.
- Confirm lazy boundaries do not capture the primary image viewer.
- Confirm chunk failure leaves a usable app and retry path.
