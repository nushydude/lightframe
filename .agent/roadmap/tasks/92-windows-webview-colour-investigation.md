# 92 - Windows/WebView colour investigation

## Status, priority, and type

- Status: planned
- Delivery classification: analysis/investigation; may close with evidence and no product change
- Priority: P2
- Type: analysis / evidence
- Dependencies: tasks 55, 84
- Expected branch: `codex/windows-webview-colour-investigation`
- Required final gate: `pnpm run ci:local`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Determine with reproducible Windows/WebView2 evidence whether monitor colour correction is already handled by the browser path and document the result; allow closure without a native transform.

## Current Code Context and source evidence

Astra explicitly leaves the outcome open. Direct render-time `getCurrentWindow` use remains in `src/hooks/useAppRuntimeLifecycle.ts:94` and `src/hooks/useImageNavigation.ts:190`; browser/headless tests cannot prove Windows monitor behavior.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

Investigation only. Do not add a colour transform based on assumption. Test ICC/profile, sRGB/wide-gamut, HDR/SDR, browser/Tauri, and monitor configurations where available. Task 71 must not depend on a positive native-transform result.

## Implementation steps

- Define a minimal reproducible matrix and capture method for Windows/WebView2/Tauri versus browser.
- Record image/profile hashes, OS/WebView2/Tauri versions, monitor profile/configuration, and screenshot limitations.
- Compare browser-managed output with known references and inspect available colour-management APIs.
- Document uncertainty, reproducibility, and whether existing path is sufficient.
- If a gap is proven, write a scoped follow-up contract rather than implementing it here.
- Link result to generated-media/export contracts without changing their ownership.

## Deterministic tests and manual evidence

To-add analysis artifacts include a reproducible protocol, representative licensed profiles/images, and manually reviewed evidence. Automated checks validate metadata completeness and no production transform is introduced; no synthetic screenshot is treated as native proof.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- Investigation records versions, fixtures, profiles, monitor context, and limitations.
- It concludes either existing browser handling is sufficient or names a separate evidence-backed gap.
- No unverified native correction is added.
- Task 71 remains implementable regardless of a negative/indeterminate result.
- Artifacts are portable and redact personal monitor/path data.

## Expected Files

Investigation protocol/results under roadmap/docs, fixture references, optional evidence parser; no product-code transform.

Proposed concrete test path (to add): scripts/validate-colour-investigation.mjs (to-add evidence metadata validation).
Proposed implementation seams: Investigation protocol/results, fixture references, evidence parser.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
node scripts/validate-colour-investigation.mjs --check
pnpm run ci:local
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Publish outcome, uncertainty, and follow-up boundary; explicitly state whether task 92 closed with no native correction.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Reject claims from headless screenshots alone.
- check reproducibility, provenance, and separation from implementation.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
