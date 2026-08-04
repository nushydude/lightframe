# 61 - Review Session Curation Model

## Priority and Type

- Priority: P1
- Type: product-domain model and persistence
- Dependencies: task 50 if curation migration touches image metadata; otherwise none
- Expected branch: `codex/review-session-curation-model`
- Required final gate: `pnpm run ci:local`

## Goal

Extend LightFrame's favorite/rating model with an explicit review decision and reliable review
progress, without changing the viewer UI beyond minimal compatibility controls.

This task provides the domain and persistence foundation for the guided Review Session UI in task
62.

## Required Data Model

Add:

```ts
type ReviewDecision = "unreviewed" | "pick" | "reject";
```

Each image's curation record must represent:

- favorite.
- rating 0–5.
- review decision.
- last-updated timestamp.

Semantics:

- Existing records migrate as `unreviewed` unless a documented deterministic mapping is approved.
- Favorite and Pick are independent unless product tests explicitly define synchronization. The
  recommended default is independent to avoid altering existing favorites.
- Rating does not implicitly change decision.
- Setting a decision updates `updated_at`.
- Clearing curation returns all fields to defaults and removes the persisted record when safe.

## Persistence and Migration

1. Increment the curation schema version where one exists.
2. Read all legacy records without data loss.
3. Persist only non-default records.
4. Preserve 256-shard distribution, journal recovery, backup recovery, corruption quarantine, and
   folder-scoped reads.
5. Multi-image decision updates use the existing batch/journal transaction behavior.
6. A failed batch must recover completely or remain visibly retryable; partial silent application is
   forbidden.
7. Unknown future decision strings must fail safely or map to `unreviewed` with a recorded migration
   warning. Define the policy in tests.

## Required Store/API Changes

- Add decision-aware read, single write, batch write, and clear behavior.
- Add indexes/sets needed for efficient pick/reject/unreviewed membership.
- Extend filter types:
  - All.
  - Picks.
  - Rejects.
  - Unreviewed.
  - existing Favorites, 4+ Stars, 5 Stars.
- Preserve current image by identity when a decision causes the active filter to remove it.
- Define navigation behavior after deciding in a filtered list:
  - advance to the next visible unreviewed image when possible.
  - otherwise choose the previous remaining item.
  - if none remain, expose a completed empty state rather than an error.

## Command and Shortcut Preparation

Add action descriptors/services for:

- Set Pick.
- Set Reject.
- Clear Decision.

Recommended shortcuts:

- `P`: Pick.
- `X`: Reject.
- `U`: Clear/Unreviewed.

Before adopting them, audit current shortcuts for conflicts. If a conflict exists, document and
choose a consistent alternative; do not silently override an existing command.

Minimal UI exposure in this task may be command-palette entries and tests. Full progress/summary UI
belongs to task 62.

## Required Rust Tests

- Legacy record deserializes as unreviewed.
- Pick/reject/default round-trip.
- Single decision updates only one shard.
- Batch decisions recover through the journal.
- Clearing the final non-default field removes the record.
- Folder-scoped read returns decision fields at 10k/100k synthetic scale.
- Unknown values follow the documented safe policy.
- Existing favorite/rating data survives migration byte-for-value semantically.

## Required Frontend Tests

- Filters return correct picks/rejects/unreviewed sets.
- Decision updates maintain immutable Zustand state.
- Active filtered navigation selects the correct next/previous image.
- Batch decisions update selection and filters atomically.
- Favorite/rating behavior is unchanged.
- Command palette and shortcut conflict tests cover the new commands.
- Curation persistence failure remains retryable.

## Diagnostics and Privacy

Diagnostics may include aggregate counts by decision but must not include lists of image paths.
Do not add analytics or network transmission.

## Expected Files

- `src/types/curation.ts`
- `src/services/curationFilter.ts`
- `src/state/curationStore.ts`
- viewer selection/navigation integration
- `src-tauri/src/curation.rs`
- curation command module
- command/action registry
- Rust and Vitest tests

## Validation Commands

```powershell
pnpm run test:run -- src/state/curationStore.test.ts src/state/viewerStore.test.ts src/services/commandRegistry.test.ts
cargo test --manifest-path src-tauri/Cargo.toml curation
pnpm run ci:local
```

## Acceptance Criteria

- Pick, Reject, and Unreviewed persist and batch correctly.
- Existing favorite/rating data migrates without loss.
- Decision filters and navigation are deterministic.
- No new full-library rewrite occurs for a single edit.
- Failure/recovery behavior matches existing curation guarantees.
- UI beyond compatibility commands is deferred to task 62.

## Reviewer Checklist

- Inspect migration against real legacy JSON shapes.
- Confirm favorite/rating semantics are unchanged.
- Check filtered navigation at first, middle, last, and final remaining items.
- Reject path-list diagnostics.
- Review multi-shard recovery and immutable frontend updates.
