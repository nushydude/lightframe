# 86 - Windows media benchmark harness

## Status, priority, and type

- Status: planned
- Delivery classification: shared evidence infrastructure
- Priority: P1
- Type: Windows performance evidence
- Dependencies: tasks 84
- Expected branch: `codex/windows-media-benchmark-harness`
- Required final gate: `pnpm run ci:local`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Measure media workloads on Windows with reproducible CPU, wall time, memory, bytes, distributions, configuration, and fixture/hardware provenance before setting thresholds.

## Current Code Context and source evidence

Astra rejects LightCraft uptime/previous-run/20% defaults as LightFrame infrastructure. No source review benchmark or performance guarantee exists.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

Record SHA/build/runtime/hardware/fixture hash/cache state/repetitions/variance. Cold application cache is not cold OS cache. Benchmarks are opt-in/explicit and must not make normal CI flaky.

## Implementation steps

- Define benchmark schema and runner modes for cold application cache, warm cache, cancellation, and queue pressure.
- Capture Windows version, CPU/GPU/memory, Rust/Node/Tauri versions, commit, fixture hashes, and configuration.
- Measure CPU/wall/memory/bytes and p50/p95/max/variance for representative decode/preview/export workloads.
- Compare bounded executor and resource-policy metrics without asserting arbitrary thresholds initially.
- Persist machine-readable results and human summary; redact paths and machine identifiers as needed.
- Document baseline approval and threshold-change review.

## Deterministic tests and manual evidence

To-add harness tests cover schema validation, missing provenance, fixture mismatch, repetition determinism, cancelled workload recording, cache-state labels, and malformed result handling. A smoke run may be manual/opt-in; normal CI validates runner logic, not wall thresholds.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- A result cannot be accepted without exact code, fixture, configuration, hardware, and cache provenance.
- Measurements distinguish application cache from OS cache and report distributions.
- Runner bounds workload/repetitions and handles cancellation/errors without corrupting results.
- No unstable wall-clock threshold is imposed on ordinary CI.
- Baseline and threshold changes require reviewable evidence.

## Expected Files

Windows benchmark runner/configuration, result schema, report parser, opt-in workflow/docs, to-add tests.

Proposed concrete test path (to add): scripts/run-windows-media-benchmark.mjs (to-add schema/config validation tests).
Proposed implementation seams: Windows benchmark runner/configuration, result schema, report parser.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
node scripts/run-windows-media-benchmark.mjs --validate-config
pnpm run ci:local
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document invocation, provenance, cache modes, privacy, baseline/threshold policy, and limitations.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Check provenance completeness, path redaction, repetition bounds, cancellation, and lack of unjustified performance promises.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
