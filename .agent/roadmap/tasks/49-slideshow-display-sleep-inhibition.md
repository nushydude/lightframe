# 49 - Slideshow Display-Sleep Inhibition

## Priority and Type

- Priority: P2
- Type: new native functionality
- Dependencies: none; implement after task 44 when practical

## Goal

Prevent the display from sleeping while a slideshow is actively advancing. Release the inhibition
immediately when the slideshow pauses or stops and unconditionally when the app exits.

## Product Rules

- Inhibit display sleep only when `isSlideshowActive && !isSlideshowPaused`.
- Pausing releases the inhibition.
- Resuming reacquires it.
- Stopping, reaching the end of a non-looping slideshow, returning to Start, closing the main
  window, or exiting after an error releases it.
- Do not inhibit system sleep for ordinary image viewing.
- Do not keep the system awake merely because a projector window is open.
- This task prevents display timeout; it does not change screen-saver policy, lock policy, battery
  settings, or enterprise power policy.

## Native API Design

Add two Tauri commands:

```text
acquire_slideshow_display_inhibition() -> Result<(), String>
release_slideshow_display_inhibition() -> Result<(), String>
```

Implementation requirements:

- Commands must be idempotent.
- Maintain one native, mutex-protected power-request handle so duplicate acquire/release calls are
  harmless.
- On Windows, use the handle-based power-request API: `PowerCreateRequest`, `PowerSetRequest` with
  `PowerRequestDisplayRequired`, and `PowerClearRequest`. Close the handle after clearing it.
- Do not use `SetThreadExecutionState` from arbitrary Tauri command threads. That API attaches state
  to the calling thread and can leak inhibition if acquire and release run on different executor
  threads.
- Add the minimum required `windows` crate feature under the existing Windows target dependency.
- On non-Windows builds, commands return success and perform no operation. Keep cross-platform CI
  compiling.
- On application/window shutdown, call the release helper from the native window-event path even if
  the frontend did not send a release command.
- Keep the OS calls in a small `display_inhibition.rs` module. Wrap the handle in a private type whose
  `Drop` implementation best-effort clears the request and closes the handle. Put that type behind
  Tauri managed state; do not expose a raw handle to command code.

## Frontend Integration

1. Add typed wrappers in `src/services/tauriCommands.ts`.
2. In `useSlideshow`, add one effect based on active and paused state:
   - acquire when effective running state becomes true.
   - release when it becomes false.
   - cleanup releases on unmount.
3. Do not call acquire on every slide change.
4. Serialize transitions so a slow acquire followed by a pause cannot finish late and leave the
   display inhibited. Use a generation/revision guard or a small promise queue.
5. Native command failure must not stop the slideshow. Log one warning per failed transition and
   continue normal playback.

## Files Expected to Change

- `src-tauri/src/display_inhibition.rs` (new)
- `src-tauri/src/lib.rs`
- `src-tauri/src/commands.rs` only if command registration is kept there
- `src-tauri/Cargo.toml`
- `src/services/tauriCommands.ts`
- `src/services/tauriCommands.test.ts`
- `src/hooks/useSlideshow.ts`
- `src/hooks/useSlideshow.test.ts`

## Required Tests

Frontend tests with mocked commands:

- Starting an unpaused slideshow acquires once.
- Normal slide advances do not reacquire.
- Pause releases once; resume reacquires once.
- Stop and non-looping end release.
- Component unmount releases.
- Acquire failure does not stop slideshow.
- A delayed acquire followed by pause ends in released state.

Rust tests:

- Duplicate acquire is idempotent.
- Duplicate release is idempotent.
- Acquire then release ends in released state.
- Shutdown cleanup and native-state Drop both release and close an acquired handle.
- Non-Windows implementation compiles and returns success.

## Acceptance Criteria

- A running slideshow requests that Windows keep the display awake.
- Pause, stop, end, close, and crash-safe native shutdown paths release the request.
- Ordinary viewing never inhibits display sleep.
- Slide navigation does not repeatedly invoke the OS API.
- Failure to inhibit is non-fatal and does not interrupt playback.

## Validation Commands

```powershell
pnpm run test:run -- src/hooks/useSlideshow.test.ts src/services/tauriCommands.test.ts
pnpm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

## Manual Windows Check

1. Temporarily set Windows display timeout to one minute.
2. Start a slideshow with a two-second interval and leave it running beyond one minute; the display
   remains on.
3. Pause the slideshow and leave the machine idle; normal display timeout resumes.
4. Resume, then stop; normal timeout resumes after stop.
5. Close LightFrame while slideshow is running; verify the process exits and normal timeout resumes.

## Non-Goals

- No user-configurable power-policy override.
- No system-sleep inhibition.
- No media-session integration.
- No slideshow scheduling.
