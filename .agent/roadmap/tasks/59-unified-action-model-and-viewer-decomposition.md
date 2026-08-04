# 59 - Unified Action Model and Viewer Decomposition

## Priority and Type

- Priority: P1
- Type: behavior-preserving frontend architecture
- Dependencies: none
- Expected branch: `codex/unified-actions-viewer-decomposition`
- Required final gate: `pnpm run ci:frontend`

## Goal

Turn the existing command registry into the single source of truth for commands rendered in the top
bar, bottom controls, context menu, command palette, pinned toolbar, and contact sheet. Decompose
`ViewerChrome.tsx` without intentionally changing layout or behavior.

This foundation prevents the later workspace redesign from copying action logic yet again.

## Current Problems

- `ViewerChrome.tsx` is more than 2,400 lines and combines state subscriptions, menu state,
  destructive operations, projector behavior, slideshow controls, rating controls, crop actions,
  edit queue, layout, and multiple command surfaces.
- Command metadata and command execution are duplicated between the command registry and chrome
  definitions.
- Availability, labels, shortcuts, icons, checked state, dangerous styling, and pinned behavior can
  drift between surfaces.
- Contact sheet repeats substantial toolbar behavior.

## Required Action Descriptor

Define one typed descriptor containing, where applicable:

```ts
type ViewerAction = {
  id: ViewerActionId;
  label: string | ((context: ActionContext) => string);
  shortLabel?: string;
  description?: string;
  icon: ToolbarIconName;
  shortcut?: string;
  keywords?: string[];
  category: ActionCategory;
  surfaces: ActionSurface[];
  isVisible: (context: ActionContext) => boolean;
  isEnabled: (context: ActionContext) => boolean;
  isChecked?: (context: ActionContext) => boolean;
  danger?: boolean;
  pinPolicy: "allowed" | "default" | "never";
  run: (context: ActionExecutionContext) => void | Promise<void>;
};
```

Use the existing product language and types where possible. Do not make React components the owner
of business actions.

## Required Architecture

Separate:

- pure action definitions.
- context derivation from Zustand/runtime state.
- action execution services.
- surface-specific presentation.
- transient UI state such as which menu is open.

Suggested components:

- `ViewerTopBar`
- `ViewerBottomBar`
- `ViewerContextMenu`
- `ViewerMoreMenu`
- `ViewerSelectionActions`
- `ViewerEditControls`
- `ViewerProjectorPrompt`
- `RatingControl`

Names may differ, but each component should have a focused responsibility and narrow props/selectors.

## Implementation Steps

1. Add characterization tests for every currently visible action and shortcut before moving code.
2. Inventory all action surfaces and build a matrix of:
   - action ID.
   - surface.
   - current label/icon/shortcut.
   - visibility and enablement condition.
   - execution function.
3. Extend or replace `commandRegistry.ts` with the unified action model.
4. Route command palette through the same descriptors.
5. Route pinned-toolbar customization through descriptor metadata.
6. Extract chrome subcomponents one at a time.
7. Migrate contact-sheet shared actions to the same model without changing grid selection behavior.
8. Keep destructive confirmations and toasts in execution services.
9. Keep menu open/close and focus state in presentation components.
10. Remove duplicated action definitions only after characterization tests cover the new source.

## Non-Goals

- Do not visually redesign toolbars.
- Do not rename modes or actions.
- Do not add Pick/Reject.
- Do not change shortcuts.
- Do not change rating/favorite persistence.
- Do not migrate the entire viewer store.
- Do not add a new UI library.

## Required Tests

- Every existing command-palette command remains present when enabled.
- Every existing toolbar action invokes the same service.
- Visibility and enablement match viewer, grid, compare, crop, slideshow, secondary-window, and empty
  states.
- Dynamic labels remain correct for slideshow pause/resume, favorite, mark, captions, projector,
  compare zoom lock, and settings.
- Dangerous actions remain styled and confirmed.
- Pinned actions round-trip through settings and ignore non-pinnable actions.
- Keyboard shortcuts and UI actions share execution behavior.
- Opening one menu closes incompatible menus and Escape behavior is unchanged.
- Store subscription counts do not materially increase; use narrow selectors.

## Quality Targets

- `ViewerChrome.tsx` becomes a composition module rather than the implementation of every control.
- No extracted component exceeds roughly 500 lines without a documented reason.
- Action definitions have unit tests independent of DOM rendering.
- No cyclic import exists between action definitions and presentation components.
- Fallow health should improve or remain stable; include before/after output in the PR.

## Validation Commands

```powershell
pnpm run test:run -- src/services/commandRegistry.test.ts src/components/ViewerChrome.test.tsx src/components/ContactSheet.test.tsx
pnpm run quality:health
pnpm run ci:frontend
```

`quality:health` may still fail the repository threshold; record the before/after score and ensure
this task does not introduce new high-complexity findings.

## Acceptance Criteria

- One descriptor is the source of action metadata and execution across all named surfaces.
- Existing visual layout and user behavior remain unchanged.
- `ViewerChrome` is decomposed into focused modules.
- Contact sheet no longer owns duplicate global action definitions.
- Characterization tests protect every migrated action.
- Frontend CI passes.

## Reviewer Checklist

- Compare the action matrix with rendered surfaces.
- Reject hidden behavior changes under a refactor label.
- Confirm action context is not captured in stale closures.
- Confirm Zustand selectors remain narrow.
- Confirm destructive operations retain confirmation and data-safety behavior.
