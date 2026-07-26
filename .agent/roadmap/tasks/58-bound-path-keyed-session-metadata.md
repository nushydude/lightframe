# 58 - Bound Path-Keyed Session Cache Metadata

## Priority and Type

- Priority: P1
- Type: memory scalability and cache correctness
- Dependencies: coordinate with tasks 29 and 35

## Goal

Prevent path-keyed metadata used during a viewing session from growing for every image ever seen,
while preserving stale-result protection and adjacent preload behavior.

## Current Evidence

- `src/components/ImageCanvas.tsx` stores resolved image metadata in
  `metadataByPathRef.current`, adding entries during image loads and reading them for adjacent
  preloads.
- No delete or clear path exists for that map when folders change, images disappear, or cache
  retention windows move.
- `src/services/imageAssetCache.ts` stores every invalidated path in `latestMutationVersions`.
- Normal image cache trimming removes assets but does not prune mutation-version history.
- Long sessions that visit many folders or receive watcher modifications can therefore retain an
  unbounded number of path strings and metadata records.

## Required Lifecycle

1. Define ownership and retention rules for each map:
   - canvas metadata retains the current image plus the configured adjacent/preload window.
   - mutation versions retain entries while a request/cache entry needs stale-result protection.
2. Clear folder-scoped metadata on folder/session reset and prune removed paths after watcher
   reconciliation.
3. Add reference or generation accounting so a mutation version is removed only after no in-flight
   request can use an older result.
4. Apply a documented hard ceiling or bounded LRU fallback for startup files and cross-folder
   transitions that are not covered by the active catalog.
5. Keep normalized path-key behavior aligned with task 35.

## Acceptance Criteria

- Map sizes remain bounded by active retention windows plus in-flight work, not lifetime unique
  paths.
- A late pre-invalidation result can never repopulate a cache with stale data after version pruning.
- Folder switches, watcher deletes/renames, cache trims, and viewer reset release obsolete entries.
- Current and adjacent image preloads retain the metadata they require.

## Required Tests and Validation

- Add test-only size snapshots or inspectors without exposing mutable maps to production callers.
- Simulate thousands of folder switches and invalidations, then assert deterministic size bounds.
- Use deferred requests to prove version entries survive until stale work settles and are then
  pruned.
- Test watcher remove/rename and session reset.
- Run focused image canvas, image asset cache, watcher, and scheduler tests.
- Run `pnpm run ci:frontend`.

## Non-Goals

- No persistent metadata database.
- No weakening of stale-result or cache invalidation guarantees.

## Reviewer Checklist

- Confirm every insertion has an explicit release path.
- Confirm pruning cannot make an old completion appear current.
- Reject wall-clock or heap-size thresholds in place of cardinality assertions.
