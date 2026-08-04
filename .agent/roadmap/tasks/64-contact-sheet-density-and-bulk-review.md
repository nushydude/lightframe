# 64 - Contact Sheet Density and Bulk Review

## Priority and Type

- Priority: P1
- Type: product design and large-folder review efficiency
- Dependencies: task 59; task 61 if Pick/Reject bulk controls are included
- Expected branch: `codex/contact-sheet-density-bulk-review`
- Required final gate: `pnpm run ci:frontend`

## Goal

Make the contact sheet useful for both visual scanning and high-volume selection by adding density
control, consolidating search/sort/filter, and replacing scattered selection controls with a sticky
bulk-action tray.

## Required Header

Place together:

- Contact Sheet title.
- visible/total result count.
- filename search.
- sort field and direction.
- curation/review filter.
- thumbnail density control.

Do not duplicate global Open/Home/mode controls already owned by the workspace shell after task 60.

## Density Model

Provide at least three named density presets:

- Compact.
- Comfortable.
- Large.

An accessible slider is acceptable if it snaps to documented values.

Requirements:

- Density changes item width, row height, thumbnail request size, and column count coherently.
- Virtualization measurements update without leaving blank gaps or stale rows.
- Current item remains visible by identity after density changes.
- Scroll position should anchor the current/first-visible image where practical.
- Requested thumbnail resolution must not remain needlessly large in Compact mode.
- Memory budgets and cache keys account for requested size.
- Persist the user's density preference only if it belongs in the settings schema with validation
  and backward-compatible defaults.

## Card Design

Each card must expose:

- image thumbnail/placeholder.
- filename.
- active/current state.
- selected state.
- favorite/rating.
- Pick/Reject/Unreviewed when task 61 exists.
- edited/pending status when available.

Badges must be readable without hover and not rely on color alone. Keep the card visually quiet in
the default state.

## Selection and Bulk Tray

When selection is non-empty, show a sticky tray:

- selected count.
- Favorite/unfavorite.
- rating 0–5.
- Pick/Reject/Clear when available.
- Copy/Move.
- Clear selection.
- dangerous overflow containing delete/trash.

Requirements:

- Tray does not cover the last grid row; reserve layout space.
- Batch operations use the exact selected image IDs.
- Pending state disables only conflicting actions.
- Partial transfer/delete failures show successes and failures without losing the remaining
  selection.
- Escape clears selection only when no higher-priority dialog/menu is open.
- Shift-click, Ctrl-click, Select All filtered results, and keyboard range selection preserve
  existing semantics.

## Virtualization and Performance

- Continue rendering only visible rows plus bounded overscan.
- Do not build DOM nodes for the full folder.
- Avoid rebuilding full selection/path sets during scroll events.
- Resize/density calculations occur through `ResizeObserver` or a bounded layout calculation.
- Scroll updates remain animation-frame throttled.
- Preload only visible/near-visible thumbnail work and cancel obsolete queued work.

## Required Tests

- Column and visible-range calculation at all densities and target widths.
- Density change preserves current image and scroll anchor.
- Thumbnail request size follows density.
- Grid has no inaccessible blank virtual rows after resize.
- Selection tray count and action enablement.
- Partial batch success/failure handling.
- Keyboard navigation across rows at different column counts.
- Range selection after filtering/search/sort.
- Curation/review badges and accessible labels.
- 100k synthetic item list test asserts bounded rendered item count, not wall-clock time.

## Manual QA

- 8, 1,000, and 100k synthetic catalog entries.
- narrow and ultrawide windows.
- all density presets.
- search/filter/sort combinations.
- keyboard-only selection.
- batch curation and injected partial transfer failure.
- light/dark themes and high scaling.

## Expected Files

- `src/components/ContactSheet.tsx` decomposed as necessary
- density/layout helpers and tests
- contact-sheet card and bulk tray components
- thumbnail cache/request integration
- settings type/store if density persists

## Validation Commands

```powershell
pnpm run test:run -- src/components/ContactSheet.test.tsx src/components/ThumbnailConsumers.test.tsx src/services/contactSheetSelection.test.ts
pnpm run ci:frontend
pnpm tauri dev
```

## Acceptance Criteria

- Density can be changed without breaking virtualization or selection.
- Search, sort, filter, count, and density form one coherent control area.
- Selection actions live in one sticky tray.
- Large synthetic lists render a bounded number of cards.
- Batch failures remain recoverable and accurately reported.
- Grid and tray are keyboard and screen-reader accessible.

## Reviewer Checklist

- Inspect virtualization math for every density and resize.
- Confirm cache/memory behavior follows thumbnail size.
- Test selection identity across sort/filter/density changes.
- Reject bulk actions that use visible indexes instead of stable IDs.
- Confirm dangerous actions stay separated and confirmed.
