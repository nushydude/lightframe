# 67 - Reduced-resolution JPEG decode

## Status, priority, and type

- Status: planned
- Priority: P1
- Type: media pipeline / JPEG performance
- Dependencies: tasks 53, 54
- Expected branch: `codex/reduced-resolution-jpeg-decode`
- Required final gate: `pnpm run ci:local`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Decode JPEGs at the nearest safe reduced scale for thumbnails and bounded previews so normal navigation avoids a full-resolution allocation while preserving orientation, requested bounds, colour handling, and detail semantics.

## Current Code Context and source evidence

Current `src-tauri/src/thumbnails.rs:478-508` and `:673` fully decode before resizing. LightCraft's `codecs/jpeg.rs:177-242` demonstrates decoder-side scaling at LightCraft `76b5377868d912db69a777bda253a5b1b96b22bd`; this is an algorithm reference only.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

The Rust resource policy remains the security boundary. Do not promise universal progressive JPEG, CMYK, or latency improvements. Preserve EXIF orientation and distinguish requested box from decoded dimensions. Reject zero/oversized requests before codec allocation.

## Implementation steps

- Inventory every JPEG entry point, including thumbnail, preview, tile, clipboard, export, and WIC fallback.
- Select the decoder scale factor from requested bounds using checked arithmetic and a documented quality/detail rule.
- Thread orientation, ICC/profile state, alpha/background policy, and source dimensions through the reduced path.
- Keep full/tiled fallback for cases the decoder cannot scale; publish only generation-current cache results through task 54.
- Add telemetry fields that distinguish reduced decode, full decode, fallback, rejection, and output dimensions.
- Document supported JPEG classes and the intentionally unpromised classes.

## Deterministic tests and manual evidence

To-add Rust tests use small fixtures and decoder spies: 1/2/4/8 scale choice, requested-box boundaries, EXIF orientation, profile/no-profile, grayscale, CMYK/YCCK/invalid profile, truncated input, and an oversized request rejected by task 53. Add a pinned same-file memory/latency comparison harness assertion only in task 86; normal CI must assert path selection and output tolerance rather than unstable timing.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- A supported JPEG request executes a reduced decode path when that scale is safe and useful.
- Output orientation, dimensions within the documented tolerance, colour policy, and thumbnail/detail semantics match the existing path.
- Unsupported or unsafe inputs take a bounded fallback or explicit error without unbounded allocation.
- Cache publication is generation/epoch safe and cancellation cannot publish stale output.
- Tests prove both reduced and fallback/rejection paths.

## Expected Files

`src-tauri/src/thumbnails.rs`, JPEG/native codec module, `src-tauri/src/image_resource_policy.rs` integration, cache telemetry, to-add Rust tests and fixture references.

Proposed concrete test path (to add): src-tauri/src/thumbnails.rs (mod tests with reduced_decode cases).
Proposed implementation seams: src-tauri/src/thumbnails.rs, JPEG codec adapter, src-tauri/src/image_resource_policy.rs, cache telemetry.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml thumbnails::tests::reduced_decode
pnpm run ci:local
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document supported JPEG classes, quality/tolerance semantics, and fallback reasons. Link task 53/54 rather than redefining their contracts.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Search all JPEG decode call sites.
- inspect integer conversions and ICC/orientation propagation.
- reject frontend-only bounds, timing claims, or a second executor/cache policy.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
