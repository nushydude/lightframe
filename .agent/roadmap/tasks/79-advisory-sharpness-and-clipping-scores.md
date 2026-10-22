# 79 - Advisory sharpness and clipping scores

## Status, priority, and type

- Status: planned
- Delivery classification: optional advisory feature
- Priority: P2
- Type: optional advisory metrics
- Dependencies: tasks 53, 67, 71, 77, 85
- Expected branch: `codex/advisory-sharpness-and-clipping-scores`
- Required final gate: `pnpm run ci:frontend`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Compute bounded, representation-aware sharpness and clipping indicators to support human review while keeping them advisory and separate from curation decisions.

## Current Code Context and source evidence

Astra explicitly excludes automatic assisted-cull mutations. Task 77 owns histogram/clipping display; this task owns score semantics and presentation.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

Fixed-resolution statistics only. State that scores are not focus/quality certainty. Never auto-Pick/Reject/delete/move. Avoid duplicate histogram implementation by consuming task 77 primitives.

## Implementation steps

- Define sharpness statistic, clipping derivation, sample/threshold/version, and unknown state.
- Compute from the rendered representation after task 71 colour policy.
- Cache by source/edit/colour/algorithm version and invalidate on changes.
- Expose compact labels/tooltips with confidence/unknown language and keyboard access.
- Provide opt-in visibility and settings persistence without changing decisions.
- Capture aggregate diagnostics only.

## Deterministic tests and manual evidence

To-add pure tests cover flat/edge/blurred patterns, clipped/no-clipping, alpha, colour conversion, thresholds, unknown/low sample, cache invalidation, and no mutation. UI tests cover advisory copy, accessible names, and disabled/error states.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- Scores are deterministic, bounded, versioned, and representation-labelled.
- Clipping data reuses task 77 semantics and does not diverge silently.
- No score changes curation or destructive actions.
- Unknown/low-confidence inputs are visible as unknown, not zero-quality.
- Tests cover adversarial and normal representations.

## Expected Files

Metrics module using histogram primitives, cache identity, UI labels, to-add tests.

Proposed concrete test path (to add): src/services/advisoryScores.test.ts (to-add score semantics cases).
Proposed implementation seams: Advisory metrics module, histogram primitives, cache identity, UI labels.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
pnpm run test:run -- src/services/advisoryScores.test.ts -t "advisory"
pnpm run ci:frontend
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document score definitions, representation limits, advisory status, and no certainty/auto-cull promises.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Challenge any automatic decision path, misleading labels, pairwise/full-resolution work, and cache staleness.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
