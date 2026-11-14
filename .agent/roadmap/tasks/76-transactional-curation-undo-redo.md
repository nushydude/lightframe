# 76 - Transactional curation undo/redo

## Status, priority, and type

- Status: planned
- Priority: P1
- Type: curation history and persistence
- Dependencies: tasks 61, 62
- Expected branch: `codex/transactional-curation-undo-redo`
- Required final gate: `pnpm run ci:frontend`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Extend task 62's Undo Last Decision into bounded transactional multi-step history with redo, bulk operations, labels/import integration, failure safety, and identity-aware invalidation.

## Current Code Context and source evidence

Astra says task 62 owns complete snapshot restoration for Undo Last Decision; this task adds history/redo/bulk and acknowledgement semantics. Curation state is in `src/state/curationStore.ts`; edit queue is separate.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

One bulk action is one transaction. No filesystem/external-editor undo. Failed persistence creates no history entry. Out-of-order acknowledgements, identity changes, and redo invalidation must be explicit.

## Implementation steps

- Define immutable curation snapshot/operation records and bounded history limits.
- Wrap single and bulk actions in a transaction coordinator that persists before commit.
- Capture labels/rating/favorite/decision and imported owned fields when present.
- Serialize acknowledgements or generation-check them to prevent stale updates.
- Invalidate/repair history on folder identity changes and external reloads.
- Expose Undo/Redo keyboard/action UI while retaining task 62's one-step affordance.

## Deterministic tests and manual evidence

To-add store tests cover one transaction, bulk transaction, failure/no-entry, redo invalidation, out-of-order acknowledgements, identity change, reload conflict, imported label/rating, and bounded eviction. UI tests cover disabled states, announcements, keyboard, and action registry integration.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- Undo and redo restore complete curation snapshots without filesystem promises.
- Bulk changes create one bounded transaction and failed persistence creates none.
- Redo is invalidated by a new mutation.
- Stale acknowledgements cannot overwrite newer identity/state.
- Task 62's Undo Last Decision remains discoverable and correct.

## Expected Files

Curation history coordinator/store, action descriptors, viewer/grid UI, to-add tests.

Proposed concrete test path (to add): src/state/curationHistoryStore.test.ts (to-add transaction/redo/failure cases).
Proposed implementation seams: Curation history coordinator/store, action descriptors, viewer/grid UI.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
pnpm run test:run -- src/state/curationHistoryStore.test.ts -t "transaction"
pnpm run ci:frontend
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document snapshot scope, persistence ordering, limits, invalidation, and explicit non-goals.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Inject failed writes and reordered promises.
- inspect identity keys, memory bound, bulk semantics, and no file undo claims.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
