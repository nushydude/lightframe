# 45 - Symmetric First and Last Image Navigation

## Priority and Type

- Priority: P1
- Type: UI/UX improvement
- Dependencies: none

## Current Behavior

The application already implements both endpoint actions:

- First image: `Home`, command palette, store action, and bottom-toolbar button.
- Last image: `End`, command palette, and store action.

The bottom toolbar exposes only First. The top toolbar also labels the landing-screen action “Home”,
while the Home keyboard key means First Image. This creates an asymmetric control row and ambiguous
terminology.

## Goal

Expose First and Last symmetrically and reserve “Home” for the keyboard's standard first-item
meaning.

## Required UI Changes

1. Add a `last` icon to `ToolbarIconName` and `ICON_PATHS`. It must mirror the visual language of the
   existing `first` icon.
2. In the viewer bottom toolbar, navigation controls must appear in this exact order:
   - First image
   - Previous image
   - Next image
   - Last image
3. The Last button must use:
   - `id="btn-ctrl-last"`
   - `aria-label="Last image"`
   - title and tooltip `Last image (End)`
4. Add an `onLast` prop to `ViewerChrome` and pass the existing `goLast` handler from `App.tsx`.
5. Rename the top-toolbar and contact-sheet landing action from visible label “Home” to “Start”. Its
   accessible label and tooltip must be `Return to start screen`.
6. Keep the landing action's existing behavior: it exits the current viewing session after the
   existing pending-edit checks. Do not bind it to the Home key.
7. Keep keyboard behavior unchanged:
   - Home goes to first image.
   - End goes to last image.
8. Keep command-palette labels `First Image` and `Last Image`.

## Boundary Behavior

- With zero images, endpoint commands remain disabled by current command enablement.
- With one image, First and Last may remain clickable but must not change state or throw.
- With multiple images, First selects index 0 and Last selects `images.length - 1`.
- Both actions use store navigation methods; components must not calculate or set indexes directly.
- The selected image's normal zoom-reset and pending-edit restoration behavior must remain the same
  as any other index navigation.

## Files Expected to Change

- `src/components/ToolbarIcon.tsx`
- `src/components/ViewerChrome.tsx`
- `src/components/ViewerChrome.test.tsx`
- `src/components/ContactSheet.tsx`
- `src/components/ContactSheet.test.tsx`
- `src/App.tsx`
- Existing store, navigation hook, keyboard, and command code should be reused, not rewritten.

## Required Tests

- ViewerChrome renders First, Previous, Next, Last in that DOM order.
- Clicking Last calls `onLast` once.
- Last has the required id, accessible name, and End tooltip.
- The top and contact-sheet landing controls say Start and have `Return to start screen` as their
  accessible name.
- Home and End keyboard regression tests continue to call `goFirst` and `goLast` respectively.
- Store tests cover zero, one, and multiple images for `navigateFirst` and `navigateLast` if those
  cases are not already covered.

## Acceptance Criteria

- First and Last are both visible in the viewer navigation row.
- Home and End keyboard shortcuts remain functional.
- “Home” is no longer used as the visible name of the landing-screen action.
- No duplicate endpoint-navigation implementation is introduced.

## Validation Commands

```powershell
pnpm run test:run -- src/components/ViewerChrome.test.tsx src/components/ContactSheet.test.tsx src/hooks/useKeyboardShortcuts.test.ts src/state/viewerStore.test.ts
pnpm run test:run
pnpm run build
```

## Non-Goals

- No history back/forward navigation.
- No first/last slideshow semantics changes.
- No toolbar-wide redesign.
- No new keyboard shortcuts.
