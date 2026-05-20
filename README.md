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

### Recently Shipped

- **Preview-first loading**: Large images render a generated preview before full-resolution pixels are requested.
- **JPEG tiled detail**: Very large JPEGs use cached viewport tiles for actual-size and deep-zoom inspection.
- **Large non-JPEG safety**: Huge PNG, TIFF, AVIF, HEIC, and SVG paths stay preview-first and avoid unsafe direct full-image decodes.
- **Shared caches and workers**: Preview, thumbnail, and image work queues are budgeted, prioritized, and shared across viewer surfaces.
- **Incremental folders**: Folder contents refresh from filesystem watcher events with persistent index support.
- **Curation workflow**: Favorites, star ratings, favorites-only review, compare mode, and copy/move actions are available from the viewer and grid.
- **Editing workflow**: Crop, crop overwrite, high-quality scaled export, lossless JPEG rotation, pending edits, and external-editor launch are in place.
- **Viewer polish**: Projector mode, slideshow controls, persistent window bounds, command palette, mouse wheel navigation, and default fit modes are implemented.
- **Format fallbacks**: HEIC/HEIF thumbnail generation uses Windows native codecs when available and falls back to clear placeholders when it is not.
- **Windows-native HEIC/HEIF previews**: When the OS codec is installed, HEIC/HEIF viewer previews are generated through Windows Imaging Component instead of the unsupported Rust decode path.
- **Windows-native HEIC/HEIF detail**: Large HEIC/HEIF files can use WIC-backed regional tiles for actual-size and deep-zoom viewing when the OS codec is available.
- **RAW sidecar workflow**: Common RAW files appear in review folders with placeholder previews and XMP sidecar metadata in the Info panel.
- **Advanced editing queue**: Scaled and cropped copy jobs can be queued, reviewed, retried, and run as a background batch.

### Next Focus

- **Release hardening**: Continue using focused performance telemetry and CI quality gates before each release.

### Later Ideas

- **RAW native previews**: Explore lightweight native or embedded-preview decode paths for common camera RAW formats.

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
Tauri/Rust changes. Commits are also guarded locally by a checked-in pre-commit hook that runs
`pnpm run commit:gate`, which fetches `origin/main` if needed and then runs the same frontend gate
CI expects. A companion `commit-msg` hook enforces Conventional Commit messages. `pnpm run quality:audit`
runs Fallow on the current branch, while `pnpm run quality:audit:ci` matches the GitHub Actions base
of `origin/main`.

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details on our code of conduct, and the process for submitting pull requests to us.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
