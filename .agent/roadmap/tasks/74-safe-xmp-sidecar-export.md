# 74 - Safe XMP sidecar export

## Status, priority, and type

- Status: planned
- Priority: P1
- Type: metadata sidecar safety
- Dependencies: tasks 51, 52, 53, 73, 75
- Expected branch: `codex/safe-xmp-sidecar-export`
- Required final gate: `pnpm run ci:local`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Provide an explicit, safe XMP sidecar export that merges owned fields while preserving foreign properties, detects concurrent edits, backs up safely, and publishes atomically.

## Current Code Context and source evidence

Astra assigns sidecar naming/merge, conflict detection, backups, atomic publication, malformed backups, and external-edit races here. Task 73 owns read/import; task 51 owns filesystem authority.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

No automatic writeback initially. Sidecars must use paired RAW/JPEG naming rules documented per supported family. Never silently overwrite an externally changed sidecar or discard foreign bytes/comments. Backup failure blocks publication.

## Implementation steps

- Define path-authorized sidecar resolution and paired-name rules.
- Read and fingerprint existing sidecar bytes, parse through task 73's bounded model, and retain foreign nodes/raw spans.
- Merge only owned fields with explicit conflict policy and user-visible preview.
- Write backup and temporary output with fsync/atomic replace semantics appropriate to Windows.
- Revalidate source fingerprint before publication and report concurrent edits/malformed backups.
- Expose explicit user action, per-file result, cancellation, and recovery via tasks 75/66.

## Deterministic tests and manual evidence

To-add integration tests cover absent/existing sidecars, aliases, foreign bytes/comments, conflict after read, malformed backup, backup failure, atomic replace failure, paired RAW/JPEG names, permissions, cancellation, and retry. Tests must verify no auto-writeback.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- Only an explicit user action writes a sidecar.
- Foreign properties remain byte/semantic-preserved within documented limits.
- Concurrent external edits are detected and never silently overwritten.
- Backup and atomic publication failures leave the original intact and are recoverable.
- All paths are authorized by task 51 and parser/write sizes are bounded by 53.

## Expected Files

Sidecar service/commands, merge and atomic write helpers, UI confirmation/result, to-add integration fixtures/tests.

Proposed concrete test path (to add): src-tauri/src/sidecar.rs (to-add merge/concurrency/atomic-write tests).
Proposed implementation seams: Sidecar service/commands, merge and atomic-write helpers, explicit UI result.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml sidecar::tests::atomic_merge
pnpm run ci:local
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document naming, merge/concurrency, backup, atomicity, malformed inputs, and no automatic writeback.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Attempt overwrite races and backup failures.
- inspect path authority, temp cleanup, foreign-property preservation, and error recovery.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
