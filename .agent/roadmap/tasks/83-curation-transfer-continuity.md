# 83 - Curation transfer continuity

## Status, priority, and type

- Status: planned
- Priority: P1
- Type: filesystem/curation consistency
- Dependencies: tasks 51, 52, 61, 75, 76
- Expected branch: `codex/curation-transfer-continuity`
- Required final gate: `pnpm run ci:local`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Keep curation metadata continuous when supported copy/move operations succeed by remapping only actual destination paths with collision, partial, cross-volume, and recovery semantics.

## Current Code Context and source evidence

Astra identified path-keyed `src/state/curationStore.ts:33`, `src-tauri/src/curation.rs:63`, and transfer/remove flows in `src/services/viewerActions.ts:59`, `src/components/ViewerChrome.tsx:698`, and `src/components/ContactSheet.tsx:566`.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

Remap only after verified filesystem success and actual destination path. Explicit copy policy; no eager content hashes or external rename inference. Never erase source curation on failed/partial operation or silently overwrite destination curation.

## Implementation steps

- Define transfer result with source/destination actual paths, operation, collision, and partial status.
- Persist a bounded recovery transaction containing the authorized source/destination set, pre-transfer curation snapshot, operation, and transaction ID **before** starting any filesystem mutation.
- Execute copy/move through the authorized native operation, then reconcile the observed filesystem result with the transaction before changing curation.
- Apply deterministic remapping/merge policy only for each actual successful destination; retain source metadata for failures, partial batches, collisions, cross-volume, case-only, and retry cases.
- Recover a filesystem-success/metadata-failure transaction on restart or retry without replaying the file mutation or silently overwriting destination curation.
- Publish mandatory per-file activity/recovery outcomes through task 75 and make the metadata commit a task 76 transaction; this is metadata history, not filesystem undo.
- Add watcher/catalog reconciliation for successful moves and unchanged failures.

## Deterministic tests and manual evidence

To-add integration tests use temp roots for copy/move success, failed source, partial batch, collision, cross-volume simulation, case-only rename, destination metadata conflict, retry/recovery, and watcher updates. Property tests ensure failed operations never erase source curation.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- A recoverable transaction is durable before each supported filesystem mutation begins.
- Successful supported transfers preserve curation on the actual destination path, including reconciliation after a filesystem-success/metadata-failure gap.
- Failed/partial/collision operations retain source metadata, report unresolved items, and do not silently overwrite destination curation.
- Copy and move semantics are explicit and deterministic across case/cross-volume conditions.
- No eager content hash or external rename inference is introduced.
- History/activity integration does not promise filesystem undo.

## Expected Files

Transfer result/curation remapper, native command integration, viewer/grid action wiring, to-add tests.

Proposed concrete test path (to add): src/services/viewerActions.test.ts (to-add transfer/metadata reconciliation cases).
Proposed implementation seams: Transfer result/remapper, native command integration, viewer/grid wiring.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
pnpm run test:run -- src/services/viewerActions.test.ts -t "transfer continuity"
pnpm run ci:local
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document operation policy, success proof, collisions, partial/recovery, and deferred identity inference.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Force every failure boundary.
- inspect ordering between filesystem and metadata commits, destination conflicts, and path authority.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
