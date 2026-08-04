# LightFrame Access Matrix

This document defines the principle of least privilege for LightFrame window capabilities and IPC command execution, as required by Task 52.

## Window Capabilities and Permissions Matrix

| Category                 | Capability              |                           Main Window (`main`)                           |  Secondary Window (`secondary` / Projector)   | Rationale                                                                 |
| :----------------------- | :---------------------- | :----------------------------------------------------------------------: | :-------------------------------------------: | :------------------------------------------------------------------------ |
| **Window Operations**    | Close window            |                                 Allowed                                  |                    Allowed                    | Both windows can be closed by user action.                                |
|                          | Show / Focus            |                                 Allowed                                  |                    Allowed                    | Positioning and displaying window when launched.                          |
|                          | Set size / position     |                                 Allowed                                  |                    Allowed                    | Resizing and moving window.                                               |
|                          | Fullscreen control      |                                 Allowed                                  |                    Allowed                    | Entering/exiting slideshow fullscreen mode.                               |
|                          | Set title               |                                 Allowed                                  |                    Allowed                    | Displaying window title.                                                  |
|                          | Webview creation        |                                 Allowed                                  |                  **Denied**                   | Only `main` window can spawn secondary projector windows.                 |
| **IPC & Events**         | Event listen/emit       |                                 Allowed                                  |                    Allowed                    | Required for `state-sync` projector synchronization.                      |
| **File Dialogs**         | File / folder picker    |                                 Allowed                                  |                  **Denied**                   | Projector view must not initiate file selection dialogs.                  |
| **Opener Plugin**        | Reveal item in folder   |                                 Allowed                                  |                  **Denied**                   | Projector must not open File Explorer / shell reveal.                     |
|                          | Launch external URL     | Allowed (`ms-settings:*`, `ms-windows-store:*`, `microsoft.com/store/*`) |                  **Denied**                   | Store links handled in main window only.                                  |
| **Updater & System**     | Check / download update |                                 Allowed                                  |                  **Denied**                   | App updating handled strictly in main window.                             |
|                          | Process restart         |                                 Allowed                                  |                  **Denied**                   | Relaunch initiated only by main window after update.                      |
| **CLI Plugin**           | CLI argument parsing    |                                 Allowed                                  |                  **Denied**                   | Initial startup CLI parsing runs on primary window.                       |
| **Application Commands** | Read commands           |                                 Allowed                                  |         Allowed (Session-restricted)          | Reading metadata/previews/tiles for authorized image IDs.                 |
|                          | Write / destructive     |                                 Allowed                                  |                  **Denied**                   | Projector cannot rotate, crop, trash, or edit images.                     |
|                          | External editor launch  |                                 Allowed                                  |                  **Denied**                   | Projector cannot launch external applications.                            |
| **Asset Serving**        | Asset protocol scope    |              Restricted (`$APPCACHE`, `$TEMP`, `$APPDATA`)               | Restricted (`$APPCACHE`, `$TEMP`, `$APPDATA`) | No global `["**"]` access; rendering restricted to generated asset roots. |

## Effective Asset Protocol Scope

The asset protocol is scoped strictly to generated cache and application data directories:

- `$APPCACHE/**/*`: Generated thumbnails, previews, and tile cache assets.
- `$TEMP/**/*`: Fallback temporary rendering storage when cache creation is unavailable.
- `$APPDATA/**/*`: Bundled resources and localized application data.

Arbitrary filesystem paths outside these permitted roots cannot be requested through `asset://` or `http://asset.localhost`.
