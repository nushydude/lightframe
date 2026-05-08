# 05 - Faster Startup

## Roadmap Item

Faster startup: keep the initial Tauri window hidden until CLI/file-association startup has resolved
the first image or empty state.

## Goal

The first visible frame should be either the requested image or the empty state. The app should avoid
showing a half-initialized window during CLI/file-association startup.

## Current Code Context

- `src/App.tsx` already calls `getCurrentWindow().show()` after parsing CLI args.
- If a file argument exists, it calls `openImage(fileArg.value)` without awaiting it and then waits
  50 ms before showing the window.
- `src-tauri/tauri.conf.json` controls initial window visibility.

## Implementation Steps

1. Verify `src-tauri/tauri.conf.json` has the main window `visible` setting set to `false`.
2. In `src/App.tsx`, replace the fixed `setTimeout(..., 50)` with explicit startup readiness state.
3. Add local state:
   - `hasStartupResolved`
   - `startupShowAttempted`
4. Change CLI handling:
   - parse CLI args
   - if file exists, `await openImage(fileArg.value)` or await a new lighter `openImageForStartup`
   - if no file exists, mark startup resolved immediately after settings load is at least requested
5. If awaiting `openImage` makes startup wait for full folder scan, split the behavior:
   - set current image immediately
   - start folder scan in background
   - resolve startup after current image path is set and title is set.
6. Ensure error cases call `show()` and render either an error banner or empty state.
7. Add a single helper function in `App.tsx`, for example `showMainWindowOnce`.
8. Avoid calling `show()` multiple times from competing effects.
9. Keep secondary window behavior unchanged; secondary windows are already created visible.

## Acceptance Criteria

- Launch with a file association shows the window only after the initial image path is ready.
- Launch without a file shows the empty state without a blank intermediate frame.
- CLI parse failures still show the app and do not leave a hidden window.
- No startup path calls `show()` more than once.

## Tests

- Add or update a component/unit test around startup logic if Tauri APIs can be mocked cleanly.
- At minimum, extract the startup decision into a small pure helper and test that helper.
- Run `pnpm test -- --run`.
- Run `pnpm build`.
- Manually smoke test `pnpm tauri dev` if possible.

## Reviewer Focus

- Watch for hidden-window deadlocks on error paths.
- Confirm file open and empty startup are both covered.
- Confirm this does not delay startup until full folder scanning completes.

