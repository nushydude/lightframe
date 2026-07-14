# 44 - Slideshow Mode Discoverability and Status

## Priority and Type

- Priority: P1
- Type: UI/UX improvement on existing functionality
- Dependencies: none

## Current Behavior

Randomized slideshow is already implemented correctly in `useSlideshow.ts` and is covered by tests.
Users can enable it in Settings or through an icon-only Shuffle button in the bottom toolbar. Loop,
direction, interval, and auto-fullscreen are split across Settings and separate icon-only controls.
The running indicator only says Slideshow or Paused, so it does not confirm whether shuffle is on.

## Goal

Make slideshow behavior understandable and configurable where the slideshow is started. Reuse the
existing slideshow engine; do not create another ordering implementation.

## Required UI

1. Add a labelled “Slideshow options” disclosure control adjacent to the Start Slideshow control in
   the bottom toolbar.
2. The disclosed panel must contain these existing settings:
   - Order: Sequential or Shuffle.
   - Direction: Forward or Reverse.
   - Repeat: Off or On.
   - Interval: integer seconds from 1 through 60.
   - Enter fullscreen automatically: Off or On.
3. Controls update `useSettingsStore` and persist through the existing settings path.
4. The existing direct Shuffle and Direction icon buttons may remain for quick access. If they
   remain, both surfaces must read/write the same settings and must never maintain local duplicate
   state.
5. Update the running indicator to show effective state:
   - Sequential example: `Slideshow · Forward · 4s`.
   - Shuffle example: `Slideshow · Shuffle · 4s`.
   - Paused shuffle example: `Paused · Shuffle · 4s`.
6. Give the indicator `role="status"` and `aria-live="polite"`. Do not announce every image change;
   announce only slideshow mode, pause, resume, start, and stop changes.
7. Add command-palette commands:
   - `Toggle Slideshow Shuffle`
   - `Toggle Slideshow Repeat`
   - `Toggle Slideshow Direction`
   Commands are enabled when at least two images are available. No new keyboard shortcut is
   assigned in this task.

## Runtime Behavior Requirements

- Starting Shuffle begins from the current image and does not show the current image again before
  every other eligible image in that cycle.
- Enabling Shuffle during an active sequential slideshow starts a new shuffled remaining cycle from
  the current image.
- Disabling Shuffle during an active slideshow continues sequentially from the current image.
- Changing interval while active resets the timer so the current slide receives the full new
  interval; it must not trigger an immediate advance.
- Changing direction while active follows the existing tested direction-reconciliation behavior.
- Opening or closing the options panel must not pause, stop, advance, or exit fullscreen.

## Files Expected to Change

- `src/components/ViewerChrome.tsx`
- `src/components/ViewerChrome.test.tsx`
- `src/services/commandRegistry.ts`
- `src/services/commandRegistry.test.ts`
- `src/hooks/useSlideshow.test.ts` only for missing runtime cases
- `src/index.css`
- Extract a small `SlideshowOptions` component if that keeps `ViewerChrome` readable.

## Implementation Steps

1. Read the five settings through narrow Zustand selectors.
2. Implement one reusable settings-update handler. Do not copy slideshow ordering logic into the
   component.
3. Build an accessible disclosure panel using the existing toolbar menu visual language.
4. Use explicit text labels inside the panel; icons alone are insufficient.
5. Derive indicator text from current settings and slideshow pause state.
6. Register the three commands in `createViewerCommands` using `useSettingsStore.getState()` at run
   time so commands do not capture stale values.
7. Add tests before changing any established shuffle semantics.

## Required Tests

- Options panel displays the current values.
- Each control updates exactly one intended setting.
- Shuffle icon, Settings panel, command palette, and options panel stay synchronized.
- Indicator text covers sequential, shuffle, paused, direction, and changed interval states.
- Changing interval while active does not advance immediately.
- Existing shuffle tests still prove no repeat before cycle exhaustion.
- Command enablement and execution tests cover all three new commands.
- Options panel is keyboard reachable, closes with Escape, and returns focus to its trigger.

## Acceptance Criteria

- A new user can find and enable randomized slideshow without opening Settings or interpreting an
  unlabeled icon.
- The running UI visibly confirms whether shuffle is active.
- There is still only one shuffle engine: `useSlideshow`.
- All options persist and take effect during an active slideshow as specified.
- No control causes an unrequested slide advance.

## Validation Commands

```powershell
pnpm run test:run -- src/components/ViewerChrome.test.tsx src/services/commandRegistry.test.ts src/hooks/useSlideshow.test.ts
pnpm run test:run
pnpm run build
```

## Non-Goals

- No transition animations.
- No music/audio playback.
- No saved slideshow playlists.
- No changes to folder Random order.
- No slideshow engine rewrite.
