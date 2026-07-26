# 60 - Audit Maintenance-Debt Cleanup

## Priority and Type

- Priority: P2
- Type: bounded maintenance and tooling correctness
- Dependencies: follow up to tasks 26, 34, 39, and 48

## Goal

Resolve five small, independently verifiable audit findings whose fixes do not justify separate
roadmap epics, while keeping each change reviewable as its own commit or checklist item.

## Current Evidence

1. `src/App.tsx` calls `useSettingsStore()` without a selector. Settings persistence fields added by
   task 48, including `saveStatus` and `saveError`, can rerender the entire application shell even
   though App does not render them.
2. `PreloadThumbnailOptions` in `src/services/thumbnailCache.ts` declares `concurrency?: number`,
   but `preloadThumbnails` never reads it. Contact Sheet passes `6` and Thumbnail Strip passes `4`;
   task 26's image-work scheduler is the actual concurrency authority.
3. `src/services/imageWorkScheduler.ts` uses
   `fallow-ignore-next-line unused-exports`, while accepted directives use the singular
   `unused-export`. The exception may therefore be stale or ineffective.
4. `package.json` reports version `8.7.3`, while `README.md` reports `8.7.0`.
5. `src/index.css` is about 3,466 nonblank lines, and the audit's duplicate analysis reported 48
   duplicated lines.

## Workstream A - Narrow App Settings Subscription

1. Replace the broad App subscription with selectors for the settings values and stable actions it
   actually consumes.
2. Use `useSettingsStore.getState()` only for event-time reads that do not need reactivity.
3. Add a render-count test proving changes to unconsumed persistence status do not rerender App.
4. Preserve all reactive theme, fit, sort, projector, startup, recent-folder, and window behavior.

## Workstream B - Remove Ignored Thumbnail Concurrency

1. Remove `concurrency` from `PreloadThumbnailOptions` and all production/test call sites.
2. Document task 26's scheduler configuration as the single concurrency authority.
3. Express any required urgency through scheduler priority, not another numeric limiter.
4. Update tests to assert scheduler limits and priority behavior rather than a no-op option.

## Workstream C - Validate Fallow Directives

1. Inventory every `fallow-ignore` directive against the installed Fallow rule names.
2. Correct or remove the scheduler directive and remove other stale suppressions.
3. Add a deterministic check that rejects unknown directive names and requires a concise reason.
4. Do not broadly exclude source paths or add replacement suppressions.

## Workstream D - Synchronize Version Metadata

1. Inventory version-bearing package, Tauri/Cargo, documentation, installer, and release files.
2. Choose one authoritative value and derive or validate required duplicates.
3. Make the README version-agnostic if a current version is not useful there.
4. Add a cross-platform version-sync check to the appropriate compliance or frontend gate.

## Workstream E - Deduplicate Global CSS

1. Capture the exact `quality:dupes` CSS findings before editing.
2. Consolidate declarations only when selectors have the same semantics and cascade requirements.
3. Split styles by stable surface ownership where that reduces duplication, leaving one explicit
   global token/reset entry.
4. Preserve themes, focus states, reduced motion, overlays, menus, and control styling.
5. Coordinate stylesheet boundaries with task 57; do not mix JavaScript component refactoring into
   this issue.

## Delivery Boundaries

- Implement each workstream as a separate commit or clearly isolated diff section.
- A workstream may be delivered independently only if its own acceptance criteria and full task
  gate pass.
- Do not upgrade pnpm or Fallow; task 39 owns toolchain-version changes.
- Do not rebalance scheduler concurrency; task 26 owns that policy.

## Acceptance Criteria

- App does not rerender for settings fields it does not consume.
- No thumbnail preload caller can pass a concurrency value that is ignored.
- Every Fallow directive names a valid rule, has a reason, and suppresses an actual finding.
- Required version values agree and a mismatch fails the version-sync check.
- Baseline CSS duplicate findings are removed or individually justified without visual regression.

## Required Tests and Validation

- Add focused tests for App render isolation and thumbnail scheduler behavior.
- Add fixtures for valid/invalid Fallow directives and matching/conflicting versions.
- Run `pnpm run quality:dead-code`, `pnpm run quality:dupes`, and `pnpm run quality:health`.
- Run affected component tests and screenshot checks for moved CSS in dark and light themes.
- Run `pnpm run ci:frontend`.

## Reviewer Checklist

- Review and approve each workstream independently; one completed item must not obscure an
  incomplete one.
- Confirm selectors remain reactive where behavior depends on settings.
- Confirm there is one concurrency authority and no compatibility shim accepts the dead option.
- Confirm tooling checks are cross-platform and read-only.
- Confirm CSS consolidation preserves specificity, import order, and accessibility states.
