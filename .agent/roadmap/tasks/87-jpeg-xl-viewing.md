# 87 - JPEG XL viewing

## Status, priority, and type

- Status: planned
- Delivery classification: optional format feature
- Priority: P2
- Type: optional format support
- Dependencies: tasks 53, 54, 84
- Expected branch: `codex/jpeg-xl-viewing`
- Required final gate: `pnpm run ci:local`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Add bounded JPEG XL viewing where a reviewed decoder and licensed fixture prove support, with clear unsupported cases and colour behavior.

## Current Code Context and source evidence

Astra calls this optional and requires a format matrix, limits, fixtures, colour handling, and dependency review. No LightFrame JXL implementation is established.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

Viewing only; no JXL editing/encoding promise. Dependency/licence/MSRV and Windows distribution must be reviewed. All work obeys 53/54; no silent WIC assumption.

## Implementation steps

- Evaluate candidate decoder/dependency and record licence, revision, MSRV, binary/distribution impact.
- Add fixture-backed signature/dimension/profile handling and bounded decode path.
- Integrate preview/thumbnail/tile cache identities and fallback/error status.
- Define supported colour/alpha/animation behavior and explicitly reject unsupported features.
- Add optional settings/format support indicator only if discoverability is needed.
- Document dependency and removal/upgrade path.

## Deterministic tests and manual evidence

To-add corpus/golden tests cover valid JXL, profile/no-profile, alpha, animated/unsupported features, huge dimensions, malformed/truncated input, wrong extension, cancellation, and no-decoder Windows behavior.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- JXL is listed supported only for fixture-backed, bounded viewing cases.
- Unsupported animation/metadata/colour cases produce explicit outcomes.
- Decoder dependency is licensed, pinned, and distribution-reviewed.
- Resource policy, executor, cache epochs, and stale rejection apply.
- No editor/encoder or sweeping compatibility claim is made.

## Expected Files

JXL decoder adapter, format matrix, dependency metadata, cache/preview wiring, to-add tests/fixtures.

Proposed concrete test path (to add): src-tauri/src/format_matrix.rs (to-add JXL matrix/limit tests).
Proposed implementation seams: JXL decoder adapter, format matrix, dependency metadata, preview/cache wiring.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml format_matrix::tests::jxl_viewing
pnpm run ci:local
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document exact JXL matrix, dependency/licence, limits, unsupported cases, and viewing-only scope.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Review dependency provenance, platform packaging, bounds, colour/alpha, and unsupported-case UX.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
