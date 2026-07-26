# 62 - Guided Review Session Workflow

## Priority and Type

- Priority: P1
- Type: flagship product workflow
- Dependencies: tasks 60 and 61
- Expected branch: `codex/guided-review-session`
- Required final gate: `pnpm run ci:frontend`

## Goal

Make "review this folder" a first-class workflow with visible progress, fast Pick/Reject decisions,
undo, completion, and a safe summary handoff.

The workflow must remain local-first and must not turn LightFrame into a permanent photo library.

## Entry Points

- Home-screen `Review Folder` primary action.
- Resume action on a recent folder with incomplete review.
- Command palette `Start Review Session`.
- Optional entry from the active folder overflow menu.

Starting a session must not create copies, move files, or alter images. It initially changes only
curation metadata.

## Session State

Track:

- session/folder identity.
- start time.
- total eligible images.
- reviewed, picked, rejected, and remaining counts.
- current image identity.
- active sort/filter.
- whether the session is newly started or resumed.
- last reversible decision action.

Persist only what is needed to resume. Derive counts from authoritative curation/catalog state where
possible so stale duplicated counters cannot drift.

## Review Interaction

Viewer review controls must provide:

- Pick.
- Reject.
- Clear decision.
- Favorite and rating remain available but visually secondary.
- Previous/next.
- Undo last decision.

Behavior:

1. A decision is persisted before the UI permanently advances.
2. On success, advance to the next unreviewed image.
3. On failure, keep the current image selected and show retry.
4. Rapid decisions serialize or use generation-safe optimistic state so acknowledgements cannot
   reorder.
5. Undo restores the complete previous curation snapshot for that image, not only the decision.
6. Undo is available until another non-review destructive/edit action invalidates it or the session
   closes.
7. Keyboard repeat must not enqueue duplicate decisions uncontrollably.

## Progress UI

Show a compact progress component containing:

- `reviewed / total`.
- picks and rejects.
- remaining count.
- progress bar with accessible text.
- Pause/Exit Review.

Do not imply that zero-rating favorites are reviewed unless they have an explicit decision.

## Completion State

When no unreviewed images remain, show a completion summary:

- total reviewed.
- picks.
- rejects.
- unrated/favorites as secondary counts.
- elapsed time.
- actions:
  - View Picks.
  - View Rejects.
  - Return to All Images.
  - Copy/Move Picks using existing safe destination workflow.
  - Finish.

Deleting rejects must not be a primary completion action. If exposed, it stays inside the existing
dangerous-action flow with explicit count and confirmation.

## Resume Behavior

- Home recent-folder card shows progress only when current catalog/curation data can produce it
  cheaply and accurately.
- A missing or moved folder produces a recoverable message and offers Remove from Recents.
- Added images increase total and appear as unreviewed.
- Removed images reduce total.
- Renamed images follow the identity policy established by session/catalog tasks.
- Changing sort does not reset review progress.

## Accessibility

- Pick/Reject controls expose pressed/decision state.
- Progress is announced politely, not after every render.
- Completion dialog traps focus and returns it on close.
- Shortcuts are visible in tooltips and settings/help.
- Color is not the only distinction between Pick and Reject.
- Reduced-motion mode avoids progress/advance animation.

## Required Tests

- New, resume, pause, exit, and complete session flows.
- Decision persistence succeeds before advancement.
- Failure keeps selection and exposes retry.
- Rapid P/X input cannot reorder state.
- Undo restores prior decision/favorite/rating snapshot.
- Added/removed watcher changes reconcile counts.
- Completion summary counts are derived correctly.
- Copy/Move Picks hands the exact authorized set to existing transfer behavior.
- Empty folder and already-complete folder states.
- Keyboard, focus, and screen-reader labels.
- Session exit returns to the same folder and current image.

## Manual QA Matrix

- 1 image, 2 images, and 1,000 synthetic images.
- all picks, all rejects, mixed decisions.
- decision persistence failure injection.
- watcher additions/removals during review.
- dark/light/system themes.
- minimum width and fullscreen.
- command palette and keyboard-only use.

## Expected Files

- New review-session state/service modules
- home screen and viewer workspace components
- action registry
- curation and watcher integration
- summary/progress/undo components
- comprehensive Vitest component and state tests

## Validation Commands

```powershell
pnpm run test:run -- src/state/curationStore.test.ts src/state/viewerStore.test.ts src/components/ViewerChrome.test.tsx
pnpm run ci:frontend
pnpm tauri dev
```

## Acceptance Criteria

- A user can start, complete, resume, and exit a review session.
- Pick/Reject is faster and clearer than combining favorite/rating manually.
- Progress cannot drift from authoritative data.
- Failed writes never silently advance.
- Undo is correct and bounded.
- Completion actions reuse safe existing transfer/filter behavior.
- The workflow is fully keyboard accessible.

## Reviewer Checklist

- Simulate persistence failures and rapid input.
- Verify all counts after watcher changes and filtering.
- Confirm no file mutation occurs merely by reviewing.
- Confirm destructive actions remain secondary and confirmed.
- Review undo invalidation and stale async acknowledgement handling.

