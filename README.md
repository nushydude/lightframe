# LightFrame 🖼️

LightFrame is a blazingly fast, minimal, and highly responsive image viewer built with [Tauri v2](https://v2.tauri.app/), [React](https://reactjs.org/), and [Rust](https://www.rust-lang.org/). It is designed to replace bloated default OS viewers by offering instant startup times, smooth keyboard navigation, and zero-distraction viewing.

## Features

- **Blazing Fast**: Native filesystem access and Rust-powered folder scanning.
- **Ultra-Responsive Navigation**: Instant keyboard navigation with debounced background loading to mimic high-performance viewers like IrfanView.
- **Smart Folder Support**: Drag and drop an image or a whole folder. LightFrame instantly understands what you want.
- **Native Natural Sorting**: Images are loaded and sorted logically (e.g., `image2` comes before `image10`), with support for sorting by Date, Size, or Random.
- **Micro-Animations & Clean UI**: A disappearing Chrome interface, dark/light themes, and buttery smooth transitions.
- **Zoom & Pan**: Fluid mouse-drag panning and shortcut-driven zoom controls.

## Roadmap

### Performance & Memory

- **Smarter image preloading**: Reuse preloaded asset URLs during navigation and only cache-bust after file-changing operations like saved rotation or crop.
- **Shared thumbnail cache**: Replace per-view base64 thumbnail caches with a shared LRU cache used by both the thumbnail strip and contact sheet.
- **Disk-backed thumbnails**: Cache generated thumbnails by file path, modified time, and size to avoid decoding the same large images across sessions.
- **Non-blocking image operations**: Move heavy thumbnail, clipboard, EXIF, rotation, and future crop work onto dedicated blocking worker tasks in Rust.
- **Faster startup**: Keep the initial Tauri window hidden until CLI/file-association startup has resolved the first image or empty state.
- **Large image preview path**: Show a fast downscaled preview first, then load full-resolution pixels when zooming or inspecting detail.
- **Folder scan optimization**: Precompute natural sort keys during folder scans and avoid repeated string/key allocation inside sort comparators.

### Viewer Polish

- **Honor default fit mode**: Apply the saved default fit/fill/actual setting whenever a new image opens.
- **Mouse wheel navigation**: Fully implement the existing "navigate" wheel mode setting.
- **Persistent window bounds**: Save and restore window size and position when the setting is enabled.
- **Navigation cache tuning**: Keep a small adjacent-image window hot without retaining stale full-size image references.
- **Command palette**: Add a fast keyboard-first way to trigger viewer actions without crowding the chrome.
- **Refresh current folder**: Add a refresh action that rescans the current folder, preserves the current image when possible, and updates the viewer after files are added, removed, or renamed outside LightFrame.

### Image Editing

- **Crop mode**: Add an interactive crop overlay with aspect ratio presets, keyboard nudging, and non-destructive preview.
- **Save cropped copy**: Start with safe "Save Copy" behavior before adding overwrite support.
- **Overwrite crop support**: Add explicit overwrite flow with confirmation, cache invalidation, and metadata preservation where possible.
- **Lossless JPEG rotation**: Prefer metadata or lossless transforms when available instead of always re-encoding pixels.
- **Edit history per image**: Track pending rotate/crop changes before committing them to disk.
- **Open in external editor**: Launch the current image in a configured editor such as Paint.NET for deeper edits outside LightFrame.

### Organization & Review

- **Favorites and ratings**: Store lightweight sidecar metadata for quick curation without modifying original files.
- **Compare view**: Show two images side by side for picking the sharper or better shot.
- **Quick copy/move workflows**: Send selected images to common folders from the viewer or contact sheet.
- **Improved format fallbacks**: Better thumbnail and metadata behavior for HEIC, AVIF, SVG, and other system-codec-dependent formats.

## Installation

You can download the latest pre-compiled installers for Windows, macOS, and Linux from the [Releases page](../../releases).

> [!NOTE]
> **Windows Users**: Because LightFrame is new and open-source, you may see a "Windows protected your PC" warning. To install, click **More info** and then **Run anyway**. This warning will disappear as the app gains more users.

## Development

To run LightFrame locally, you'll need [Node.js](https://nodejs.org/), [pnpm](https://pnpm.io/), and [Rust](https://www.rust-lang.org/tools/install) installed.

```bash
# Clone the repo
git clone https://github.com/yourusername/lightframe.git
cd lightframe

# Install frontend dependencies
pnpm install

# Run the Tauri dev server
pnpm tauri dev
```

## Build for Production

To compile the application into a standalone binary/installer:

```bash
pnpm tauri build
```

## Quality Gates

Before pushing broad changes, run the same guardrails used by CI:

```bash
pnpm run ci:local
```

For scoped work, use `pnpm run ci:frontend` for React/TypeScript changes and `pnpm run ci:rust` for
Tauri/Rust changes. `pnpm run quality:audit` runs Fallow on changed code and blocks newly introduced
dead code, complexity, and duplication regressions.

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details on our code of conduct, and the process for submitting pull requests to us.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
