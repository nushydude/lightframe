# 81 - Paginated contact-sheet export

## Status, priority, and type

- Status: planned
- Priority: P1
- Type: bounded document export
- Dependencies: tasks 54, 64, 72, 75, 80
- Expected branch: `codex/paginated-contact-sheet-export`
- Required final gate: `pnpm run ci:local`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Export a selected snapshot of the contact sheet as a bounded, paginated PDF with captions and safe output publication.

## Current Code Context and source evidence

Astra found Artcraft contact sheets are raster pages packaged as PDF; this is a new LightFrame capability. Existing interactive grid/contact sheet owns selection, density, and bulk controls.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

Snapshot selection at start; bound pages, cells, captions, raster pixels, and total bytes. Do not duplicate interactive grid or imply unrestricted image output. No partial final file after failure.

## Implementation steps

- Define immutable selection snapshot and ordering/caption policy.
- Calculate bounded page layout from task 64 density and task 80 sizing without reusing UI DOM.
- Stream/rasterize pages through task 54 with progress/cancel stages from task 75.
- Apply task 72 colour/metadata policy and safe destination/collision handling.
- Write temporary output and atomically publish only a complete PDF.
- Add accessible export summary and per-file/page errors.

## Deterministic tests and manual evidence

To-add tests cover empty/one/many selection, page boundaries, long captions, missing thumbnails, oversized selection, byte/page caps, cancellation at render/publication, collision, partial failure, and atomic cleanup. Golden PDF metadata/page count comes from task 85 where stable.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- Export uses a start-time selection snapshot and deterministic ordering.
- Page, pixel, caption, and byte bounds are enforced before work.
- Cancellation/error leaves no partial final output and reports completed work accurately.
- PDF colour/metadata/output policies follow task 72 and presets follow task 80.
- Interactive grid remains the selection owner.

## Expected Files

Contact-sheet export service/command, PDF layout/renderer, activity integration, UI action, to-add tests/goldens.

Proposed concrete test path (to add): src-tauri/src/contact_sheet_export.rs (to-add bounded PDF tests).
Proposed implementation seams: Contact-sheet export service/command, PDF layout/renderer, activity integration.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml contact_sheet_export::tests::bounded_pdf
pnpm run ci:local
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document page/layout limits, snapshot semantics, captions, colour/privacy policy, and output safety.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Inspect memory/page streaming, cancellation/publication races, selection drift, and partial-file cleanup.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
