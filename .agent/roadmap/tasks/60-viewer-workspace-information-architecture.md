# 60 - Viewer Workspace Information Architecture

## Priority and Type

- Priority: P1
- Type: product design and interaction hierarchy
- Dependencies: task 59
- Expected branch: `codex/viewer-workspace-ia`
- Required final gate: `pnpm run ci:frontend`

## Goal

Redesign the viewer chrome around four clear work modes—View, Grid, Compare, and Present—while
reducing duplicated navigation and giving the image itself more visual priority.

The task changes layout and hierarchy, not underlying media, curation, edit, or projector behavior.

## Product Principles

- The current image and review decision are primary.
- Modes are mutually understandable destinations, not unrelated toolbar buttons.
- Global navigation and folder actions live in one stable area.
- Image navigation/zoom live in one contextual area.
- Advanced edit, integration, diagnostics, and destructive actions use progressive disclosure.
- Every action remains reachable by keyboard and command palette.

## Required Layout

### Global/header region

Include:

- folder/file title and visible/total image count.
- mode switch: View, Grid, Compare, Present.
- search/filter entry when meaningful.
- Open/Folder/Recent access through a compact source control.
- one overflow menu for secondary global actions.

### Contextual image region

Include:

- previous/next plus first/last through either visible controls or well-labeled overflow on narrow
  windows.
- zoom out, fit/actual-size state, and zoom in.
- current review controls such as favorite/rating/mark until Pick/Reject arrives in task 62.
- edit-state indicator and Save/Reset only when an edit is pending.

Do not render a second persistent copy of navigation or mode controls.

## Responsive Requirements

Test widths:

- minimum supported 640px.
- 800px.
- 1200px.
- 1600px or wider.

At narrow widths:

- mode labels may collapse to icons only when tooltips and accessible names remain.
- less frequent actions move into overflow.
- image count and current filename truncate safely.
- no horizontal page scrollbar appears.
- touch targets remain at least 36 CSS pixels; aim for 40–44 where space allows.

## Home Screen Improvements Included

Replace the current repeated recent-folder preset chips with compact recent-folder cards:

- folder label.
- elided path in tooltip/details.
- last-opened relative/absolute time.
- primary Resume action.
- filtered views in an overflow/menu.

Do not read folder thumbnails or add review progress yet; those depend on later review/catalog tasks.
Keep drag-and-drop, Open Image, and Open Folder prominent.

## Visual and Interaction Requirements

- Use existing design tokens and `ToolbarIcon`.
- Remove inline style definitions encountered in the touched home/chrome components.
- Bundle Inter locally or use the Windows system font stack; remove runtime Google Fonts requests.
- Replace starter Vite favicon/resource references with LightFrame branding.
- Ensure toolbar groups have meaningful names and separators are not announced.
- Tooltips must show label and shortcut.
- Preserve auto-hide behavior in fullscreen/slideshow, but a pointer or keyboard interaction must
  reveal controls predictably.
- Menus should return focus to their trigger when closed.

## Migration Steps

1. Add screenshots or DOM characterization for current major modes.
2. Implement the new layout using the action descriptors from task 59.
3. Migrate View mode first.
4. Migrate Grid and Compare mode headers.
5. Treat Present as the entry point for slideshow/projector options; do not merge the underlying
   slideshow and projector state machines.
6. Update home screen cards.
7. Remove redundant old controls only after shortcut and command-palette parity tests pass.
8. Update CSS in focused sections or modules; do not reformat all 4,000 lines of global CSS.

## Required Tests

- Correct mode is selected and announced in each view.
- Only one persistent navigation control group is rendered.
- All former actions remain reachable through visible UI or overflow.
- Mode transitions preserve current image, zoom rules, selection, and pending edits.
- Fullscreen/slideshow chrome reveal/hide remains correct.
- Home recent-folder cards call the same open/filter behavior.
- Narrow viewport tests verify overflow decisions and no inaccessible hidden actions.
- Keyboard focus order follows visual order.
- Remote-font network references are absent from the built HTML.

## Manual Visual QA

Use synthetic images and capture:

- empty home with and without recent folders.
- standard viewer at all target widths.
- grid with no selection and multi-selection.
- compare with zoom locked and unlocked.
- crop/pending edit.
- slideshow paused/running.
- light, dark, and system themes.
- keyboard focus rings and Windows high scaling.

## Validation Commands

```powershell
pnpm run test:run -- src/components/ViewerChrome.test.tsx src/components/ContactSheet.test.tsx src/components/EmptyState.test.tsx
pnpm run ci:frontend
pnpm tauri dev
```

## Acceptance Criteria

- View, Grid, Compare, and Present are expressed as a coherent mode system.
- Persistent duplicate navigation/mode controls are removed.
- Every previous action remains available.
- Home recent-folder actions are less repetitive.
- The app no longer contacts Google Fonts at startup.
- Minimum-window layout is usable and keyboard accessible.
- Visual QA evidence is attached to the PR.

## Reviewer Checklist

- Review all four modes and narrow widths.
- Compare action parity against task 59's matrix.
- Reject hidden functionality with no discoverable replacement.
- Confirm no product state resets solely because the layout changed.
- Confirm local font/branding assets are licensed and bundled correctly.

