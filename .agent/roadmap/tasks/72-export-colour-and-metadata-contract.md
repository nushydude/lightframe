# 72 - Export colour and metadata contract

## Status, priority, and type

- Status: planned
- Priority: P1
- Type: export safety and interoperability
- Dependencies: tasks 51, 52, 53, 59, 75
- Expected branch: `codex/export-colour-and-metadata-contract`
- Required final gate: `pnpm run ci:local`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Make export behaviour explicit for profile preservation/conversion/stripping, metadata retention, GPS privacy, and normalized orientation while preserving safe existing output machinery.

## Current Code Context and source evidence

Astra found LightFrame already has safe export machinery but needs a clear preserve/convert/strip and metadata/GPS contract. Existing export commands in `src-tauri/src/commands/mod.rs` and `src/types/settings.ts` are current integration points.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

Profile preservation differs from pixel transformation. No automatic source writeback. GPS policy must be explicit and default-safe. Use task 51 path authority, task 54 executor admission, and task 75 activity when exports are wired; do not duplicate preset UI from task 80.

## Implementation steps

- Inventory scaled/cropped/export commands, encoders, EXIF/XMP paths, and existing settings.
- Define typed export options and defaults for profile, metadata groups, GPS, orientation, and alpha.
- Apply policy before encoding with checked resource admissions and atomic destination publication.
- Surface per-file policy/result and partial failure semantics through unified activity.
- Add migration/default handling without changing existing files implicitly.
- Document format-specific unsupported metadata and profile behavior.

## Deterministic tests and manual evidence

To-add integration tests cover preserve/convert/strip, GPS on/off, normalized orientation, alpha, missing/invalid profiles, metadata expansion limits, collisions, partial failures, and atomic cleanup. Property tests verify no source mutation and option round trips.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- Every export has a visible/typed colour and metadata policy.
- GPS privacy default and explicit override are enforced in Rust before publication.
- Orientation/profile and metadata outcomes are deterministic and documented.
- Failures leave no partial output and report per-file status.
- Existing safe export behavior remains available through the new contract.

## Expected Files

Export option types/commands, metadata policy, encoder integration, activity wiring, to-add tests and docs.

Proposed concrete test path (to add): src-tauri/src/commands/mod.rs (to-add `commands::tests::export_colour_metadata` integration tests).
Proposed implementation seams: `src-tauri/src/commands/mod.rs` export registration and tests, metadata policy, encoders, activity wiring.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml commands::tests::export_colour_metadata
pnpm run ci:local
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document defaults, privacy, profile semantics, unsupported fields, and relationship to task 80 presets.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Check source immutability, atomic writes, GPS stripping, profile-vs-transform semantics, and partial failures.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
