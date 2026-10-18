# 84 - Licensed pinned media corpus

## Status, priority, and type

- Status: planned
- Delivery classification: shared evidence infrastructure
- Priority: P0
- Type: test evidence and provenance infrastructure
- Dependencies: none
- Expected branch: `codex/licensed-pinned-media-corpus`
- Required final gate: `pnpm run ci:local`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Create an immutable, licensed, hash-pinned media corpus manifest that supports codec, RAW, colour, metadata, export, and recovery tests without branding or untracked downloads.

## Current Code Context and source evidence

Astra requires immutable pins, hashes, per-file provenance, and CI failure when required fixtures are absent. Reviewed Artcraft manifests are MIT OR Apache-2.0, but individual assets/corpora/profiles are separate.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

No branded assets, personal images, fonts, model weights, or unreviewed profiles. Keep fixture sizes bounded and licences explicit. Required fixtures cannot silently skip; synthetic fixtures complement but do not prove native codecs.

## Implementation steps

- Define manifest schema with file ID, format/family, SHA-256, dimensions, licence, source revision, and allowed use.
- Select minimal licensed RAF/TIFF-family/CR3/JPEG/JXL/PSD/HEIF/XMP/colour fixtures and synthetic generators.
- Store or fetch fixtures through a deterministic documented mechanism without secrets or network dependence in normal CI.
- Add integrity/licence validation and clear missing-fixture failure mode.
- Provide per-task fixture selectors and provenance output to logs.
- Review retention and update policy; never mutate a pinned fixture in place.

## Deterministic tests and manual evidence

To-add manifest tests verify hashes, licence fields, duplicate IDs, path traversal, size caps, missing required fixture failure, and deterministic selection. Codec tasks must reference fixture IDs; no `skip` on missing required files.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- Every required fixture has a reproducible hash and provenance/licence record.
- CI fails clearly when a required fixture is absent or altered.
- Fixture selection is bounded, deterministic, and path-safe.
- No branding or unlicensed corpus enters the repository.
- Feature tasks can consume IDs without owning a competing corpus.

## Expected Files

Corpus manifest/provenance docs, validation script/test, fixture storage or controlled retrieval metadata, per-task mappings.

Proposed concrete test path (to add): scripts/validate-test-corpus.mjs (to-add manifest validator tests).
Proposed implementation seams: Corpus manifest/provenance, fixture validation, per-task fixture mappings.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
node scripts/validate-test-corpus.mjs --check
pnpm run ci:local
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document licences, pin/update process, fixture classes, size/network policy, and synthetic versus native evidence.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Audit every licence/hash/source, missing-fixture behavior, path traversal, and secret/network assumptions.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
