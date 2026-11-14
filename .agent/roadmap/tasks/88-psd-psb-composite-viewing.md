# 88 - PSD/PSB composite viewing

## Status, priority, and type

- Status: planned
- Delivery classification: optional format feature
- Priority: P2
- Type: optional format support
- Dependencies: tasks 53, 54, 71, 84
- Expected branch: `codex/psd-psb-composite-viewing`
- Required final gate: `pnpm run ci:local`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Display bounded flattened PSD/PSB composites for fixture-backed cases without promising layer editing or full Photoshop fidelity.

## Current Code Context and source evidence

Astra notes LightCraft PSD rejects Lab/ZIP cases and requires a matrix/fixtures/colour limits. No LightFrame composite viewer is established.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

Composite viewing only. Define unsupported compression/colour/profile/layer cases; do not expose layer editing, virtual copies, or document round-trip claims. Bound decompression and image dimensions before allocation.

## Implementation steps

- Evaluate parser/decoder and licence/MSRV/dependency impact.
- Define PSD/PSB header/section/compression limits and select composite source.
- Decode only flattened composite data via task 53 and task 54.
- Preserve/convert colour per task 71 and report source/composite dimensions.
- Add fallback/error status and no-layer-editing UI language.
- Document fixture-backed matrix and dependency update process.

## Deterministic tests and manual evidence

To-add fixtures/goldens cover PSD/PSB, ZIP/RLE/unsupported compression, Lab/RGB/CMYK, profiles, alpha, large dimensions, malformed sections, truncated data, cancellation, and no-decoder fallback.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- Supported PSD/PSB cases render a bounded composite with honest colour/profile behavior.
- Unsupported Lab/ZIP/other cases are explicit and recoverable.
- No layer editing, full fidelity, or round-trip write is implied.
- Dependency/licence and fixture provenance are reviewable.
- Limits, executor, cache, and stale-generation rules apply.

## Expected Files

PSD/PSB composite adapter, format matrix, dependency metadata, preview/cache integration, to-add tests/fixtures.

Proposed concrete test path (to add): src-tauri/src/format_matrix.rs (to-add PSD/PSB matrix tests).
Proposed implementation seams: PSD/PSB composite adapter, format matrix, dependency metadata, preview/cache wiring.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml format_matrix::tests::psd_composite
pnpm run ci:local
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document composite-only scope, supported compression/colour matrix, limits, and unsupported outcomes.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Inspect section bounds, decompression bombs, colour conversion, dependency licence, and UI claims.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
