# 73 - Namespace-aware XMP import

## Status, priority, and type

- Status: planned
- Priority: P1
- Type: metadata import and curation identity
- Dependencies: tasks 50, 53, 61, 84
- Expected branch: `codex/namespace-aware-xmp-import`
- Required final gate: `pnpm run ci:local`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Import owned rating, label, and caption fields from namespace-aware XMP with provenance-aware presence and minimal UI/storage semantics while retaining foreign properties.

## Current Code Context and source evidence

Astra requires aliases, attribute/element forms, RDF language alternatives/lists, clearing owned fields, foreign bytes/comments, parser budgets, and local-zero rating presence. Current curation storage is `src/state/curationStore.ts` and native metadata commands.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

No stale quick-xml reintroduction. Local zero rating requires explicit presence/provenance, not default-value inference. Task 61 owns decisions, not LC-specific metadata semantics. Import is bounded by 53 and must not auto-write.

## Implementation steps

- Define namespace URI/prefix normalization and owned-field mapping with provenance.
- Parse attribute/element forms, aliases, language alternatives/lists, and explicit clears under parser budgets.
- Merge imported values with local state using a documented precedence/conflict model.
- Preserve unknown namespaces/raw foreign properties for task 74 without lossy reserialization.
- Expose minimum label/caption/rating presence UI and map only owned fields.
- Add source fingerprint/generation to prevent stale metadata acknowledgements.

## Deterministic tests and manual evidence

To-add parser/property tests cover aliases, element/attribute forms, RDF lang alternatives/lists, explicit clears, zero rating presence, unknown namespaces, comments/bytes preservation handoff, malformed/oversized XML, duplicate fields, and external edits. Required fixtures are licensed/pinned by task 84.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- Owned fields import by namespace URI, not prefix spelling alone.
- Explicit zero/clear values retain presence/provenance and do not collapse into absence.
- Unknown namespaces and foreign bytes survive the import/export handoff.
- Malformed/oversized XMP is rejected or partially reported within policy limits.
- No automatic writeback or decision mutation occurs.

## Expected Files

XMP parser/model, curation metadata merge/UI, native command integration, fixture manifest, to-add tests.

Proposed concrete test path (to add): src-tauri/src/xmp.rs (to-add namespace/provenance parser tests).
Proposed implementation seams: XMP parser/model, curation metadata merge/UI, bounded command integration.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml xmp::tests::namespace_aware
pnpm run ci:local
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document owned namespaces, provenance, conflict/clear behavior, parser limits, and that decisions remain task 61's owner.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Inspect namespace matching, merge semantics, parser bounds, foreign-byte preservation, and no-writeback behavior.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
