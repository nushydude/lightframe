# 69 - TIFF/RAW embedded previews

## Status, priority, and type

- Status: planned
- Priority: P1
- Type: RAW preview container support
- Dependencies: tasks 53, 54, 84
- Expected branch: `codex/tiff-raw-embedded-previews`
- Required final gate: `pnpm run ci:local`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Add bounded embedded-preview discovery for TIFF-based LightFrame-supported RAW families such as DNG, CR2, NEF, and ARW where fixtures prove coverage.

## Current Code Context and source evidence

Astra identified unbounded extent/prefix growth in Artcraft `files.rs:743` and whole-file fallback in `fs_preview_loader:695` at LightCraft revision `76b5377868d912db69a777bda253a5b1b96b22bd`. LightFrame's supported extension list is the authority for in-scope families.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

Use TIFF-family containers only; enumerate every supported extension backed by a real fixture instead of making a sweeping camera claim. Bounds precede seek/read/decode. Handle endian/IFD recursion and metadata expansion within 53. No sensor decode or full RAW editor.

## Implementation steps

- Inventory LightFrame-supported TIFF-based RAW extensions and choose a parser strategy that cannot follow untrusted offsets without a budget.
- Implement bounded IFD/tag traversal with recursion, entry-count, bytes, and seek limits.
- Select preview-bearing sub-IFDs by dimensions/quality while returning honest source and embedded dimensions.
- Pass embedded JPEG/TIFF data to bounded decoders and profile/orientation policy.
- Define recoverable outcomes for missing/corrupt preview, wrong extension, source changes, and no Windows codec.
- Add per-family fixture records and explicit unsupported entries.

## Deterministic tests and manual evidence

To-add real fixture tests cover DNG/CR2/NEF/ARW only where the manifest includes license/provenance, plus big-endian/little-endian, huge/overflow/truncated offsets, recursive IFD, malformed JPEG, missing preview, wrong extension, changed source, and no-codec fallback. Property tests generate IFD metadata without allocating payload extents.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- Each claimed family has a pinned fixture and a documented support row.
- Parser enforces seek, entry, metadata, range, and decoded-resource limits before allocation.
- Valid previews preserve orientation/profile and report source versus embedded dimensions.
- Unsupported or malformed files return a bounded fallback/error and never whole-file read by accident.
- Tests prove a family is unsupported when no fixture/decoder contract exists.

## Expected Files

TIFF/RAW preview parser and loader, resource-policy/executor integration, supported-family matrix, fixture manifest, to-add Rust tests.

Proposed concrete test path (to add): src-tauri/src/raw_preview.rs (to-add TIFF-family traversal tests).
Proposed implementation seams: TIFF/RAW preview parser/loader, resource policy, supported-family matrix, fixture manifest.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml raw_preview::tests::tiff_family_bounded
pnpm run ci:local
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Maintain a format matrix with DNG/CR2/NEF/ARW examples only when verified. State that RAW sensor development is deferred.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Review IFD offset arithmetic, recursion caps, endian handling, and fallback behaviour.
- reject camera-wide or sensor-decode claims.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
