# 70 - CR3 embedded previews

## Status, priority, and type

- Status: planned
- Priority: P1
- Type: RAW preview container support
- Dependencies: tasks 53, 54, 84
- Expected branch: `codex/cr3-embedded-previews`
- Required final gate: `pnpm run ci:local`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Scan CR3 container structures within strict byte/range budgets to extract an embedded preview without implementing raw sensor decoding.

## Current Code Context and source evidence

Astra required a separate CR3 family task and bounded container scan. LightFrame currently has no verified CR3 preview contract; Artcraft source comparison is at LightCraft `76b5377868d912db69a777bda253a5b1b96b22bd`.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

Bound every box/offset/length, recursion, and candidate count before reading. Do not parse arbitrary MP4 media or expose a generic container reader. No sensor decode, camera coverage promise, or whole-file fallback.

## Implementation steps

- Define the minimal CR3 signatures/boxes needed to locate preview candidates.
- Implement checked bounded scanning with cancellation checkpoints and maximum container depth/bytes.
- Validate the candidate JPEG/HEIF through existing bounded decoders and colour/orientation policy.
- Expose an honest source/embedded resolution and unsupported-codec result.
- Add stale source/cache epoch checks and diagnostics that avoid full paths.
- Document exact fixture-backed CR3 scope.

## Deterministic tests and manual evidence

To-add fixture/property tests cover valid candidates, malformed/truncated boxes, overflow offsets, nested/deep boxes, huge declared lengths, wrong extension, missing preview, source change, no-codec fallback, and candidate selection. Required CR3 samples are pinned/licensed by task 84; absent required fixtures fail CI.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- CR3 scanning never follows an unvalidated extent or reads the whole container as fallback.
- Fixture-backed CR3 previews render with orientation/profile and bounded decoded dimensions.
- Malformed/unsupported containers produce recoverable preview fallback/error.
- Cancellation and cache epochs prevent stale publication.
- No raw sensor/development capability is implied.

## Expected Files

CR3 scanner/preview loader, resource-policy/executor integration, fixture manifest, to-add tests.

Proposed concrete test path (to add): src-tauri/src/raw_preview.rs (to-add CR3 box-scan tests).
Proposed implementation seams: CR3 scanner/loader, resource policy, fixture manifest.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml raw_preview::tests::cr3_bounded
pnpm run ci:local
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document CR3 as bounded embedded-preview viewing only, with fixture-backed coverage and unsupported outcomes.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Audit box parser limits and all arithmetic.
- verify no generic MP4 parser or raw sensor path is introduced.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
