# 82 - Pending editor draft recovery

## Status, priority, and type

- Status: planned
- Priority: P1
- Type: editor recovery
- Dependencies: tasks 51, 52, 53
- Expected branch: `codex/pending-editor-draft-recovery`
- Required final gate: `pnpm run ci:frontend`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Recover an unqueued crop/rotation editor draft after interruption with source-fingerprint revalidation and explicit restore/discard choices.

## Current Code Context and source evidence

Astra separates this from task 66 queued job intent/recovery. Existing viewer crop/rotation state is in `src/state/viewerStore.ts`; edit queue persistence is separate.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

Only unsaved, unqueued crop/rotation draft state. Never replay an export or overwrite automatically. Revalidate source path/fingerprint and dimensions before offering restore. Keep drafts bounded and privacy-conscious.

## Implementation steps

- Define draft schema/version, source identity/fingerprint, transform bounds, and timestamp/expiry.
- Persist atomically at explicit draft checkpoints with bounded size and redacted diagnostics.
- On startup/folder open, revalidate source existence/fingerprint and offer restore/discard.
- Handle source changed, missing, malformed, expired, and multiple drafts deterministically.
- Apply restored state only after user confirmation; discard clears the draft safely.
- Coordinate activity/support messaging without moving task 66's queued recovery ownership.

## Deterministic tests and manual evidence

To-add tests cover crash/interruption boundaries, valid restore, changed/missing source, malformed/oversized/expired draft, multiple identities, discard failure, rotation/crop bounds, and no automatic overwrite. Component tests cover focus, keyboard, and explicit choices.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- Only valid unqueued crop/rotation drafts are offered for restore.
- Source/fingerprint changes block automatic application and explain why.
- Restore/discard are explicit, bounded, and recoverable.
- Queued exports remain task 66's owner and are not replayed here.
- No source file is mutated by draft persistence or discovery.

## Expected Files

Draft persistence/service, viewer/edit state integration, startup dialog/toasts, to-add tests.

Proposed concrete test path (to add): src/state/editorDraftStore.test.ts (to-add restore/discard/fingerprint cases).
Proposed implementation seams: Draft persistence/service, viewer/edit state, startup recovery dialog.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
pnpm run test:run -- src/state/editorDraftStore.test.ts -t "draft recovery"
pnpm run ci:frontend
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document schema, expiry, fingerprint policy, restore/discard semantics, and queue boundary.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Inject interrupted writes and source changes.
- verify no overwrite, path leakage, or queued-job duplication.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
