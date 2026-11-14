# 89 - Non-WIC HEIF fallback

## Status, priority, and type

- Status: planned
- Delivery classification: optional format feature
- Priority: P2
- Type: optional format fallback
- Dependencies: tasks 53, 54, 84
- Expected branch: `codex/non-wic-heif-fallback`
- Required final gate: `pnpm run ci:local`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Provide a reviewed non-WIC HEIF/HEIC viewing fallback for Windows environments where WIC lacks support, with strict dependency, licence, and resource limits.

## Current Code Context and source evidence

Astra assigns a separate non-WIC HEIF task and warns distribution/dependency review belongs here. Existing WIC path and format fallback behavior are in `src-tauri/src/native_codecs.rs` and thumbnail paths.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

Viewing fallback only; no broad codec bundle or encoder promise. Review patents/licence/distribution constraints with the selected library. Do not bypass task 53 or duplicate WIC results without cache identity.

## Implementation steps

- Inventory WIC capability detection and define when fallback may be selected.
- Evaluate candidate decoder with legal/distribution/MSRV review and pinned revision.
- Implement bounded decode/profile/alpha handling and parity/fallback status.
- Add cache identity for backend/profile and cancellation/executor integration.
- Expose clear diagnostics for WIC versus fallback and unsupported 10-bit/sequence cases.
- Document installer/runtime packaging and removal strategy.

## Deterministic tests and manual evidence

To-add corpus/golden tests cover WIC available/unavailable, HEIF/HEIC 8/10-bit, alpha, profiles, sequences/unsupported, malformed/truncated/huge inputs, cancellation, and dependency-missing fallback.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- Fallback activates only when configured/needed and remains bounded.
- WIC/fallback outputs have documented colour/alpha/dimension semantics.
- Dependency, licence, patent/distribution and runtime packaging decisions are recorded.
- Unsupported features produce explicit recoverable results.
- No encoder or universal Windows compatibility claim is made.

## Expected Files

WIC capability/fallback adapter, dependency/provenance docs, cache/preview integration, to-add fixtures/tests.

Proposed concrete test path (to add): src-tauri/src/native_codecs.rs (to-add WIC/fallback tests).
Proposed implementation seams: WIC capability/fallback adapter, dependency/provenance, cache/preview integration.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml native_codecs::tests::heif_fallback
pnpm run ci:local
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document fallback selection, legal/dependency limits, supported matrix, packaging, and unsupported behavior.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Audit fallback trigger, dependency distribution, 10-bit/alpha colour, bounds, and stale cache separation.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
