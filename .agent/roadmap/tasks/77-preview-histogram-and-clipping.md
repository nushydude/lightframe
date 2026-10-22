# 77 - Preview histogram and clipping

## Status, priority, and type

- Status: planned
- Priority: P1
- Type: display analysis
- Dependencies: tasks 53, 54, 71, 85
- Expected branch: `codex/preview-histogram-and-clipping`
- Required final gate: `pnpm run ci:frontend`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Display bounded histogram and clipping summaries for the rendered preview representation, with source/colour labels and invalidation tied to image/edit/colour identity.

## Current Code Context and source evidence

Astra limits this to display pixels, not RAW exposure analysis. Existing preview/tile and viewer UI provide representation boundaries; generated colour contract is task 71.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

Bound display pixels, bins, sampling, and memory. Label representation and profile. Do not claim RAW sensor/exposure truth, alter curation, or run unbounded analysis on originals.

## Implementation steps

- Define histogram/clipping sample contract, bins, channels, alpha handling, and invalidation identity.
- Compute from bounded rendered preview/tile data through task 54 scheduling.
- Expose source/representation/profile labels and stale/loading/error states.
- Add optional overlay/panel with keyboard and accessible text; preserve reduced motion.
- Cache only by source/edit/colour generation and retire stale results.
- Document approximation and clipping thresholds.

## Deterministic tests and manual evidence

To-add pure tests cover constant/gradient/alpha/gray/CMYK-converted/wide-gamut/no-profile, clipping thresholds, sample bounds, stale invalidation, cancellation, and malformed pixels. Component tests cover labels, loading/error, and no RAW certainty claim.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- Histogram/clipping is bounded and tied to a specific rendered representation.
- Source/edit/colour changes invalidate old results before publication.
- UI labels approximation, profile, and representation clearly.
- No curation/export mutation or RAW exposure promise is introduced.
- Tests prove deterministic bins and clipping thresholds.

## Expected Files

Histogram/statistics module, executor request, viewer panel/overlay, cache identity, to-add tests.

Proposed concrete test path (to add): src/services/histogram.test.ts (to-add bounded representation tests).
Proposed implementation seams: Histogram/statistics module, viewer panel/overlay, cache identity.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
pnpm run test:run -- src/services/histogram.test.ts -t "bounded"
pnpm run ci:frontend
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document representation, sampling, bins, clipping semantics, and explicit RAW non-goal.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Inspect bounds, stale cache, colour label, alpha math, accessibility, and memory use.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
