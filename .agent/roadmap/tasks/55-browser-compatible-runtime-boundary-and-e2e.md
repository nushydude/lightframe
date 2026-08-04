# 55 - Browser-Compatible Runtime Boundary and Tauri E2E Harness

## Priority and Type

- Priority: P1
- Type: developer experience, integration testing, regression prevention
- Dependencies: none
- Expected branch: `codex/runtime-boundary-e2e`
- Required final gate: `pnpm run ci:local`

## Goal

Make `pnpm dev` render a useful browser development surface without crashing, and add a small
end-to-end harness that exercises the real Tauri shell on Windows.

The browser surface is for UI development and deterministic tests. It must not pretend to provide
privileged filesystem behavior. The Tauri harness remains the authority for native integration.

## Confirmed Defect

`pnpm dev` currently reaches `getCurrentWindow()` during React render and crashes because Tauri
window metadata is unavailable. The README documents `pnpm dev`, so the command must either work or
be explicitly replaced with a documented supported alternative.

## Required Runtime Boundary

Create a single environment/runtime abstraction for:

- current window label and window actions.
- event listen/emit.
- dialogs.
- file/folder open.
- drag/drop.
- startup arguments.
- asset URL conversion.
- update/restart behavior.

React components and general hooks must not call Tauri globals during render. They should consume a
typed adapter injected at application startup.

Required adapters:

1. `TauriRuntimeAdapter` using the real APIs.
2. `BrowserDevelopmentAdapter` with deterministic in-memory behavior and explicit unsupported
   responses for privileged operations.
3. Test adapter/builders for Vitest.

## Browser Development Experience

At minimum, `pnpm dev` must:

- render the home screen.
- open a bundled or generated synthetic demo catalog without reading personal files.
- navigate viewer, grid, compare, settings, and command palette.
- demonstrate ratings/favorites in memory.
- label the surface as development/demo mode.
- disable destructive/native-only actions with a clear explanation.
- log no uncaught errors on startup.

Do not add a browser file-upload path unless explicitly needed; avoid transmitting or persisting
user files in the dev surface.

## Tauri E2E Harness

Add a Windows-compatible smoke/integration harness using the smallest practical tool already
compatible with the repository. New dependencies require justification.

The harness must:

- build or launch a controlled Tauri test executable.
- create a temporary synthetic image folder.
- launch LightFrame against that folder.
- wait for the main window using an explicit readiness signal.
- exercise deterministic interactions where the chosen automation layer supports them.
- collect logs/screenshots on failure.
- close the process and remove temporary fixtures.

Required journeys:

1. Startup with no file: home screen visible.
2. Startup/open synthetic folder: image count and first selected image are correct.
3. Navigate next/previous and enter/exit grid.
4. Set a rating/favorite and verify persistence after restart.
5. Open/close Settings and command palette with keyboard shortcuts.
6. Projector creation may be a separate conditional Windows test if multi-window automation is
   reliable.

Destructive edit/move/delete tests are not required in this first harness.

## Testability Requirements

- Runtime feature detection is centralized and unit tested.
- No test mutates global Tauri objects in ad hoc per-file mocks.
- Browser adapter state resets between tests.
- Async listeners return cleanup functions and are tested for unmount safety.
- React Strict Mode does not duplicate startup side effects.
- Browser mode cannot invoke real updater, process, reveal, or filesystem commands.

## Documentation

Update README development instructions:

- `pnpm dev` for UI demo/development.
- `pnpm tauri dev` for native behavior.
- the exact E2E command and prerequisites.
- limitations of browser demo mode.

Add the E2E command to `package.json` and ensure the quality-discovery script recognizes it if
appropriate.

## Expected Files

- New runtime adapter modules under `src/services/runtime/`
- `src/main.tsx`, startup/lifecycle hooks, and Tauri-dependent services
- Browser demo fixtures
- Vitest adapter tests
- Windows E2E/smoke scripts
- `package.json`, README, and possibly CI workflow

## Validation Commands

```powershell
pnpm dev
pnpm run test:run
pnpm run build
pnpm tauri build --no-bundle --ci
pnpm run smoke:windows
pnpm run e2e:windows
pnpm run ci:local
```

## Acceptance Criteria

- `pnpm dev` renders without a Tauri metadata crash.
- Browser mode visibly and safely communicates its limitations.
- React code has one runtime boundary rather than scattered environment checks.
- The Windows harness covers the five required journeys.
- Failures produce actionable logs/artifacts.
- Existing packaged startup smoke behavior remains intact.

## Reviewer Checklist

- Reject direct `window.__TAURI__` checks scattered across components.
- Confirm browser mode cannot accidentally call privileged APIs.
- Confirm E2E fixtures contain no user-specific paths or files.
- Review startup/listener cleanup under React Strict Mode.
- Verify the new harness fails when a required UI assertion is intentionally broken.
