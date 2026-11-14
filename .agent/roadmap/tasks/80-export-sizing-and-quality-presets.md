# 80 - Export sizing and quality presets

## Status, priority, and type

- Status: planned
- Priority: P1
- Type: export UX and validation
- Dependencies: tasks 59, 72, 75
- Expected branch: `codex/export-sizing-and-quality-presets`
- Required final gate: `pnpm run ci:frontend`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Add persistent export presets for long-edge sizing, no-upscale, encoder quality, and format choices while routing output through task 72's colour/metadata contract.

## Current Code Context and source evidence

Astra assigns long-edge/no-upscale/quality/persistence UI here; LightFrame already has scaled export machinery and settings parsing in `src/types/settings.ts`.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

No source overwrite or implicit metadata policy. Enforce bounds in Rust task 53 even when presets come from UI. Presets are user preferences, not per-file silent mutations.

## Implementation steps

- Define preset schema/version, defaults, migration, and invalid-value normalization.
- Build size/quality controls with long-edge/no-upscale preview and format capability display.
- Translate presets into task 72 export options and bounded native command inputs.
- Persist settings safely and handle reset/import/invalid storage.
- Show estimated dimensions and per-file partial results through task 75.
- Document quality semantics by format and no-upscale behavior.

## Deterministic tests and manual evidence

To-add type/store/component tests cover defaults, migration, invalid values, long-edge math, no-upscale, quality bounds, format capability, task 72 option mapping, keyboard/focus, and narrow layouts. Rust integration proves UI cannot bypass limits.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- Presets persist and migrate without changing source files.
- Long-edge and no-upscale calculations are deterministic and bounded.
- Quality/format options map to task 72's explicit contract.
- Oversized/invalid values are rejected by backend policy.
- UI exposes clear preview, reset, and partial-result states.

## Expected Files

Preset types/store, export controls, settings persistence, option mapping, to-add tests.

Proposed concrete test path (to add): src/state/exportPresetStore.test.ts (to-add migration/math/quality cases).
Proposed implementation seams: Preset types/store, export controls, settings persistence, task 72 mapping.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
pnpm run test:run -- src/state/exportPresetStore.test.ts -t "preset"
pnpm run ci:frontend
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document preset fields, migrations, quality semantics, and ownership split with task 72.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Check backend validation, overflow, persistence recovery, and no hidden overwrite/metadata behavior.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.
