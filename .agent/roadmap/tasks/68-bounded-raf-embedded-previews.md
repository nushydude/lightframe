# 68 - Bounded RAF embedded previews

## Status, priority, and type

- Status: planned
- Priority: P1
- Type: RAW preview container support
- Dependencies: tasks 53, 54, 67, 84
- Expected branch: `codex/bounded-raf-embedded-previews`
- Required final gate: `pnpm run ci:local`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Discover and decode embedded JPEG previews in RAF files through bounded range reads, with explicit source dimensions, orientation/profile handling, and safe fallback.

## Current Code Context and source evidence

Astra found RAF-only range discovery in the Artcraft `raw/preview.rs:219` at revision `76b5377868d912db69a777bda253a5b1b96b22bd`. LightFrame has format fallbacks and native limits but no verified RAF bounded path.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

RAF only. No sensor/demosaic RAW editor. Validate offsets, lengths, integer conversions, file size, and metadata expansion before allocation or seeking. Never grow a prefix to a declared extent without a cap; never silently fall back to whole-file read.

## Implementation steps

- Define RAF signatures and a bounded range-reader interface on top of task 53 admissions.
- Parse candidate preview offsets/lengths with checked arithmetic and a maximum scan/range budget.
- Validate the embedded JPEG independently through task 67's decoder contract.
- Propagate source dimensions, orientation, ICC/profile, and honest preview resolution.
- Handle missing/corrupt preview, wrong extension, truncated range, changed source fingerprint, and no-codec Windows fallback.
- Record bounded rejection/fallback reasons and keep cache epoch/cancellation behavior from task 54.

## Deterministic tests and manual evidence

To-add corpus-driven Rust tests cover valid RAF, multiple candidate previews, huge/overflow/truncated offsets, bad/missing JPEG, wrong extension, source changes, absent preview, and no-codec fallback. Property tests generate offset/length pairs without allocating the declared ranges. Required fixtures are pinned by task 84 and must fail when absent.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- RAF preview discovery reads only validated bounded ranges.
- A valid embedded JPEG preserves declared orientation/profile and reports embedded dimensions honestly.
- Malformed, hostile, missing, or changed sources fail recoverably without whole-file fallback or partial cache publication.
- Resource admissions and cancellation apply before range allocation and decode.
- Tests use real pinned RAF fixtures plus generated boundary cases.

## Expected Files

New/updated RAF preview parser under `src-tauri/src/`, preview loader, resource-policy/executor integration, fixture manifest, to-add Rust tests.

Proposed concrete test path (to add): src-tauri/src/raw_preview.rs (to-add RAF bounded-range tests).
Proposed implementation seams: RAF preview parser/loader, resource policy, executor integration, fixture manifest.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml raw_preview::tests::raf_bounded
pnpm run ci:local
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Record RAF scope, caps, supported preview resolution, and unsupported sensor behaviour. Cross-reference 53, 54, 67, 84.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Check all offset arithmetic before allocation.
- inspect whole-file fallback removal.
- verify no generic camera support is claimed.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.

## Implementation candidate notes

The implementation uses `src-tauri/src/raw_preview.rs` and the existing thumbnail/preview,
metadata-command, resource-policy, and native-codec modules. No dependencies were added.
Only the authoritative big-endian JPEG offset/length fields at bytes 84/88 of the 92-byte RAF
header are selected; alternative JPEG candidates are ignored rather than scanned. The selected
range is capped at 32 MiB. Existing Task 53 source-file admissions apply, and JPEG header and
metadata scanning is capped at 8 MiB/65,536 markers, including metadata between progressive scans.
The admitted source descriptor is used without buffered read-ahead; checked range arithmetic,
snapshot checks, and cancellation precede range allocation. Native codec entry points reject RAF
containers, including malformed ones.

The embedded JPEG reuses Task 67's reduced decoder with a JPEG-only full fallback. Dimensions
refer to the oriented embedded preview, with no sensor-resolution inference. ICC chunks are
bounded and checked for consistent, complete sequence numbering; profile bytes are retained
opaquely in generated JPEGs. Profiles are neither validated for colour correctness nor converted.
Profiled CMYK/YCCK previews are unsupported because decoding changes their pixel colour space.
JPEG decoder failures may use the existing placeholders. Container validation, resource admission,
I/O, cancellation, source-change, and unsupported-profile errors propagate as recoverable failures.
Existing Task 54 executor,
source fingerprints, and cache-generation publication remain authoritative. RAF cache keys have
a scoped version suffix to avoid reusing older native/placeholder results.

Implemented deterministic checks include the required integrity-checked native RAF, exact traced
header/range reads, generated offset/length boundary pairs, source leases and changes, malformed
JPEG/ICC and metadata budgets, decoy candidates, orientation/profile roundtrips, native-entry
exclusion, thumbnail/preview/metadata integration, and executor cancellation/cache-clear barriers.
`cargo test --manifest-path src-tauri/Cargo.toml raw_preview::tests::raf_bounded` and the broader
`cargo test --manifest-path src-tauri/Cargo.toml raf_bounded` are concrete nonzero filters.
Full local gates and independent review must still determine delivery readiness.
