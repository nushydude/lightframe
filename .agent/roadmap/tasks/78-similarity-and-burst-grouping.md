# 78 - Similarity and burst grouping

## Status, priority, and type

- Status: planned
- Delivery classification: optional advisory feature
- Priority: P2
- Type: optional advisory grouping
- Dependencies: tasks 67, 71, 85
- Expected branch: `codex/similarity-and-burst-grouping`
- Required final gate: `pnpm run ci:frontend`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Offer deterministic, advisory similarity and burst grouping from bounded fixed-resolution statistics to help review navigation without deciding, deleting, or moving files.

## Current Code Context and source evidence

Astra separates grouping from advisory sharpness/clipping and excludes assisted-cull mutations. Existing folder/catalog and curation identities are the integration surface.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

Use fixed-resolution previews/statistics and cache identities. Define threshold/version semantics and unknown-data behavior. No subject recognition, content-hash mandate, auto-reject, or external rename inference.

## Implementation steps

- Define group feature vector/version, sampling dimensions, thresholds, and stable ordering.
- Compute lazily through bounded preview/statistics paths and persist only safe cache identities.
- Represent groups as advisory views that never alter curation decisions.
- Reconcile additions/removals/renames through catalog identity policy.
- Add UI affordances for inspect/expand/dismiss and keyboard navigation.
- Document false positives, unknowns, and reset/version migration.

## Deterministic tests and manual evidence

To-add property tests cover identical/near/different images, orientation, colour policy, missing previews, threshold boundaries, stable ordering, additions/removals, cache version change, and no mutation. Component tests cover advisory labels and empty/error states.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- Grouping is deterministic for the same feature/version/input set.
- Every result identifies the feature/version and handles unknown inputs honestly.
- Groups do not mutate Pick/Reject, delete, move, or auto-select assets.
- Cache and computation are bounded and cancelable.
- UI remains useful when no groups are found.

## Expected Files

Grouping statistics/service, cache/version types, grid/review UI, to-add tests.

Proposed concrete test path (to add): src/services/similarityGrouping.test.ts (to-add deterministic grouping cases).
Proposed implementation seams: Grouping statistics/service, cache/version types, grid/review advisory UI.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
pnpm run test:run -- src/services/similarityGrouping.test.ts -t "group"
pnpm run ci:frontend
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document grouping algorithm contract at a high level, advisory status, limits, and non-goals.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Reject content-hash creep, hidden curation mutations, unbounded pairwise work, and subject/focus claims.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
