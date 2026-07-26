# 57 - Decompose Oversized Frontend and Native Modules

## Priority and Type

- Priority: P2
- Type: architecture refactor
- Dependencies: coordinate with active feature tasks; task 40 remains the security-scope owner

## Goal

Split oversized files along responsibility boundaries so future changes can be reviewed, tested, and
loaded independently without altering product behavior.

## Current Evidence

The audit measured these nonblank line counts:

- `src/components/ViewerChrome.tsx`: about 2,436 lines.
- `src/components/ImageCanvas.tsx`: about 1,188 lines.
- `src/App.tsx`: about 960 lines.
- `src-tauri/src/commands.rs`: about 3,225 lines.
- `src-tauri/src/thumbnails.rs`: about 1,921 lines.

Fallow reported a health score of 78/B and major cognitive-complexity concentrations in `App`,
`ViewerChrome`, `ContactSheet`, `ImageCanvas`, and `useImageNavigation`. Complexity suppressions
currently hide several of these boundaries rather than documenting a small exceptional algorithm.

## Refactor Plan

1. Capture characterization tests for each extraction boundary before moving code.
2. Extract `ViewerChrome` panels/menus and command wiring into focused components while keeping one
   orchestration shell.
3. Extract `ImageCanvas` metadata, tile/full-image loading, and adjacent preload coordination into
   focused hooks/services with explicit inputs.
4. Extract `App` startup/listener lifecycle, projector sync, and window persistence into hooks that
   own their cleanup.
5. Split Rust commands by domain (`curation`, folder/watcher, image metadata, edit/export, and
   window/system integration) while preserving Tauri command names and registration.
6. Split generated-cache policy/accounting from thumbnail/preview/tile generation.
7. Remove complexity suppressions only when the owning function is actually below the configured
   threshold.

## Delivery Boundaries

- Execute each numbered extraction as a behavior-preserving commit or separately reviewed PR; do
  not perform a whole-file rewrite.
- Keep public TypeScript exports, Tauri command payloads, persisted formats, and user-visible
  behavior stable.
- CSS decomposition and duplicate removal belong to task 60.
- Tauri capability and asset-protocol hardening remains task 40 and must not be bundled here.

## Acceptance Criteria

- Each named file has a documented single orchestration responsibility after extraction.
- No newly extracted production function exceeds the repository cognitive-complexity limit without
  a specific justification.
- Command names, payload serialization, startup behavior, image rendering, and viewer controls
  remain compatible.
- Focused modules have direct tests instead of relying only on end-to-end component coverage.
- Fallow health improves without adding replacement suppressions or excluding files.

## Required Tests and Validation

- Run focused characterization tests after every extraction slice.
- Run `pnpm run quality:health` and record before/after complexity evidence.
- Run `pnpm run ci:local`.

## Non-Goals

- No UI redesign, state-library replacement, database migration, or permission expansion.
- No feature work mixed into extraction commits.

## Reviewer Checklist

- Review moves separately from behavior changes.
- Confirm listener/resource ownership and cleanup become clearer.
- Reject thin wrapper files that merely move complexity without creating a boundary.
