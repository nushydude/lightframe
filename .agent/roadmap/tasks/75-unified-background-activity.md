# 75 - Unified background activity

## Status, priority, and type

- Status: planned
- Priority: P1
- Type: workflow status and cancellation
- Dependencies: tasks 54, 59
- Expected branch: `codex/unified-background-activity`
- Required final gate: `pnpm run ci:local`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Present scan, transfer, export, preview, and background work through one truthful activity model with per-stage cancelability, partial success, bounded terminal history, and recoverable errors.

## Current Code Context and source evidence

Astra recommends a new activity surface after the executor and action descriptor owners. Existing `src/state/toastStore.ts`, `src/state/editQueueStore.ts`, and image scheduler provide partial patterns.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

Cancellation is not rollback of completed writes. Do not duplicate task 54 queue telemetry or task 66 queued recovery. Never promise cancelability for noninterruptible native stages; expose that state.

## Implementation steps

- Define activity IDs, stages, progress units, state transitions, error/partial-success shape, and retention bound.
- Adapt executor/job, transfer, export, and scan producers to publish events.
- Build a single frontend store/service with subscriptions that avoid render loops.
- Add cancel/retry/open-result actions through the unified action registry.
- Render a compact activity tray with keyboard/focus/accessible announcements and terminal-history limit.
- Redact paths in diagnostics and hand off queued intent/recovery to task 66.

## Deterministic tests and manual evidence

To-add state-machine tests cover stage transitions, indeterminate progress, cancelable/noncancelable stages, partial success, retry, terminal retention, duplicate events, producer failure, and completed-write semantics. Component tests cover tray focus, reduced motion, keyboard cancel, and screen-reader labels.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- All in-scope producers use one activity identity and lifecycle model.
- Progress and cancellation labels are truthful per stage.
- Partial success and errors retain actionable results without losing completed work.
- Terminal history is bounded and subscriptions do not cause loops.
- Queued recovery remains task 66's owner.

## Expected Files

Activity types/store/service, producer adapters, tray components/styles, action descriptors, to-add tests.

Proposed concrete test path (to add): src/state/activityStore.test.ts (to-add activity lifecycle cases).
Proposed implementation seams: Activity store/service, producer adapters, tray components.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
pnpm run test:run -- src/state/activityStore.test.ts -t "activity lifecycle"
pnpm run ci:local
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document lifecycle, cancelability, partial success, retention, and handoff boundaries.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Test duplicate/out-of-order events, cancellation after publication, UI accessibility, and bounded memory.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
