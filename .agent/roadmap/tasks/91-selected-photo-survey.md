# 91 - Selected-photo survey

## Status, priority, and type

- Status: planned
- Delivery classification: optional workflow feature
- Priority: P2
- Type: optional review workflow
- Dependencies: tasks 61, 62, 64
- Expected branch: `codex/selected-photo-survey`
- Required final gate: `pnpm run ci:frontend`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Offer a focused survey of selected photos for rapid decision review and comparison without creating a second curation model.

## Current Code Context and source evidence

Astra assigns Survey-selection separately from decisions/filter/progress and grid bulk. Existing selection/bulk UI is in `src/components/ContactSheet.tsx` and curation state.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

Use task 61 decisions and task 62 session progress. Survey selection is a view/snapshot, not a new persistence owner. No auto-rating/rejection, file mutation, or selection content hash.

## Implementation steps

- Define survey snapshot, ordering, entry/exit, selection drift, and empty states.
- Reuse grid selection and action descriptors; show Pick/Reject/clear and existing metadata.
- Support keyboard navigation, compare handoff, and focus return.
- Reconcile watcher additions/removals and stale selections safely.
- Expose optional summary and return to source grid/session without resetting progress.
- Document survey versus review-session semantics.

## Deterministic tests and manual evidence

To-add tests cover snapshot selection, empty/single/many, watcher changes, session progress, keyboard/focus return, compare handoff, decision failure, and no duplicate persistence model.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- Survey uses the selected set at entry and handles drift explicitly.
- Decisions persist through task 61/62 and progress remains authoritative.
- Entry/exit returns focus and context without resetting grid/session.
- No file mutation or hidden auto-decision occurs.
- Accessibility and narrow/wide layouts are covered.

## Expected Files

Survey view/state adapter, grid/session actions, tests/styles/docs.

Proposed concrete test path (to add): src/components/ContactSheet.test.tsx (to-add survey selection/focus cases).
Proposed implementation seams: Survey view/state adapter, grid/session actions, layout/accessibility.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
pnpm run test:run -- src/components/ContactSheet.test.tsx -t "survey"
pnpm run ci:frontend
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document survey snapshot, decision ownership, focus/return behavior, and non-goals.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Check selection drift, duplicate state, stale writes, focus restoration, and action registry reuse.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
