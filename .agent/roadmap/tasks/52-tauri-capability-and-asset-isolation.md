# 52 - Tauri Capability and Asset Isolation

## Priority and Type

- Priority: P0
- Type: Tauri configuration and window isolation
- Dependencies: task 51
- Supersedes: unimplemented portions of task 40
- Expected branch: `codex/tauri-capability-asset-isolation`
- Required final gate: `pnpm run ci:local`

## Goal

Apply least privilege to Tauri capabilities and asset serving after folder-session authority exists.
Remove the global asset-protocol `["**"]` scope and prevent the projector window from invoking
main-window administrative, write, dialog, updater, process, or external-editor behavior.

## Required Access Matrix

Before editing configuration, create a checked-in or task-comment access matrix with rows for every
window and columns for:

- core window operations.
- event listen/emit.
- dialog open/save.
- opener reveal and URL launch.
- updater check/download.
- process restart.
- application read commands.
- application write/destructive commands.
- generated asset rendering.

The intended result is:

### Main window

- Can create folder/file/destination/editor grants through explicit user actions.
- Can perform authorized read and write commands.
- Can use updater and relaunch.
- Can reveal an authorized item.
- Can create/close the projector window.

### Secondary/projector window

- Can receive the minimal synchronized viewer state.
- Can render only authorized current image/generated assets.
- Can close itself and perform required fullscreen/window actions.
- Cannot open dialogs, update/relaunch, reveal files, delete/move/write images, manage settings, or
  launch an external application.

## Asset Strategy

Choose one of these approaches and document why:

1. Preferred: render only generated assets from `$APPCACHE`/approved temporary cache directories,
   with original files decoded or streamed through authorized commands.
2. Acceptable: dynamically extend an asset scope only for active session files/folders if the Tauri
   runtime safely supports revocable scopes.

Static `["**"]`, `$HOME/**/*`, or another equivalently broad scope does not satisfy the task.

The scope should explicitly allow:

- generated thumbnail, preview, and tile cache roots.
- any controlled temporary fallback root used when cache creation fails.
- bundled resources.

It should explicitly avoid:

- arbitrary configuration, credential, browser-data, and hidden files.
- source files outside active user grants.
- file types that never need WebView rendering.

## Implementation Requirements

1. Split `src-tauri/capabilities/default.json` into named main and projector capabilities.
2. Replace `core:default` where a smaller explicit core permission set is practical.
3. Remove unused permissions discovered during the access-matrix inventory.
4. Narrow `assetProtocol.scope` and CSP sources to the implemented rendering paths.
5. Ensure secondary windows are created with a label matching only the projector capability.
6. Add deny permissions when they materially protect against future accidental additions.
7. Keep Microsoft Store codec links working through the existing URL allow list.
8. Preserve updater, restart, file dialogs, reveal, drag/drop, startup, generated caches, and
   projector behavior in the main window.
9. Add a startup assertion or debug diagnostic that reports the effective asset roots without
   exposing personal paths in normal production logs.

## Required Tests

- Configuration schema validation/build succeeds.
- Main window can perform each allowed capability from the matrix.
- Projector can render and close.
- Projector cannot invoke at least one representative command from each denied category.
- An arbitrary local image path outside the session/cache cannot be loaded through the asset
  protocol.
- Generated previews, thumbnails, SVG placeholders, and tiles still render after restart.
- Cache fallback behavior remains functional when the primary cache directory is unavailable.
- Remote URL opening remains limited to the existing Microsoft Store patterns.

If permission-denial tests cannot run as Rust unit tests, add a packaged or Tauri integration smoke
script that invokes the command from each window label and asserts allow/deny results.

## Expected Files

- `src-tauri/capabilities/*.json`
- `src-tauri/tauri.conf.json`
- projector-window creation code
- generated-asset URL helpers
- security/integration smoke tests
- `.agent` or developer documentation describing the access matrix

## Validation Commands

```powershell
pnpm run build
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build --no-bundle --ci
pnpm run smoke:windows
pnpm run ci:local
```

## Acceptance Criteria

- No universal filesystem asset glob remains.
- Main and projector windows have distinct capabilities.
- The projector is read-only at the IPC/plugin boundary.
- All generated asset formats render from explicitly permitted roots.
- Existing main-window workflows in the access matrix pass.
- The PR documents every retained permission and why it is required.

## Reviewer Checklist

- Compare effective permissions, not just file organization.
- Reject scopes that are broad aliases for `**`.
- Attempt representative denied calls from the projector.
- Confirm fallback cache paths cannot silently require global scope.
- Confirm CSP and asset scope agree and do not reintroduce remote script execution.

