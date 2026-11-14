# 90 - Compare targeting and candidate promotion

## Status, priority, and type

- Status: planned
- Delivery classification: optional workflow feature
- Priority: P2
- Type: optional compare workflow
- Dependencies: tasks 59, 60, 61, 62, 76
- Expected branch: `codex/compare-targeting-and-candidate-promotion`
- Required final gate: `pnpm run ci:frontend`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Make compare targets explicit and allow a deliberate candidate promotion action while retaining existing shared pan/zoom and safe curation semantics.

## Current Code Context and source evidence

Astra says shared compare zoom/pan already exists and this is a separate optional action-target/candidate-promotion task. `src/state/viewerStore.ts` already tracks primary/secondary/focused panes and promotion.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

Do not rewrite compare zoom/pan or action registry. Promotion changes an explicit target/role, not files. Preserve task 61 decisions and task 62 workflow state; no auto-cull.

## Implementation steps

- Define target roles, candidate selection, focus/keyboard semantics, and persistence scope.
- Extend existing compare state/actions without duplicating descriptors.
- Add visible target/promotion affordances and accessible labels.
- Guard promotion against stale indices, removed images, and single-image folders.
- Integrate curation actions only after explicit target confirmation.
- Document session/reset behavior and no-file-mutation semantics.

## Deterministic tests and manual evidence

To-add store/component tests cover target changes, promotion, stale/removal reconciliation, keyboard focus, single-image/empty states, decision handoff, redo/undo boundaries, and no filesystem mutation.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- Users can identify, change, and promote compare targets deliberately.
- Existing pan/zoom behavior remains intact.
- Stale or removed candidates are handled without wrong-image mutation.
- Promotion and decisions use the shared action model and remain reversible within curation scope.
- Accessibility and keyboard focus are complete.

## Expected Files

Compare state/actions/UI/tests/docs.

Proposed concrete test path (to add): src/state/viewerStore.test.ts (to-add compare target/promotion cases).
Proposed implementation seams: Compare state/actions/UI, shared action descriptors, focus/stale-index handling.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
pnpm run test:run -- src/state/viewerStore.test.ts -t "compare target"
pnpm run ci:frontend
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document target roles, promotion semantics, state lifetime, and non-goals.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Exercise rapid candidate changes, stale acknowledgements, keyboard focus, and action ownership.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
