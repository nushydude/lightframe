# LightFrame

LightFrame is a fast, Windows-first desktop image viewer and photo review app built with
[Tauri v2](https://v2.tauri.app/), [React](https://react.dev/), and Rust. It focuses on quick
startup, responsive keyboard navigation, large-folder review, and practical curation tools without
turning the viewer into a full photo manager.

The app is currently at version `8.1.3`.

## Current State

LightFrame is an actively developed Tauri desktop app with a React frontend, Rust filesystem and
image-processing commands, local settings/curation persistence, updater support, and GitHub Actions
quality gates. The release workflow currently builds Windows packages only, although the codebase
uses cross-platform Tauri where possible.

## Features

- Fast file and folder opening with drag-and-drop, CLI/file-association startup, recent folders, and
  cached folder indexes.
- Keyboard-first navigation with natural filename sorting, date/size/random sort options, fullscreen
  viewing, slideshow mode, and configurable mouse wheel behavior.
- Preview-first image loading with adjacent-image preloading, bounded in-memory caches, and
  performance modes for Fast, Balanced, and Low Memory use.
- Large-image safety paths that avoid unsafe full-resolution decodes for huge non-JPEG images.
- Deep zoom for large JPEG images through cached viewport tiles, with Windows-native tiled detail for
  HEIC/HEIF when the OS codec is available.
- Thumbnail strip and virtualized contact sheet grid for large folders.
- Favorites, 0-5 star ratings, curation filters, saved review presets, and side-by-side compare mode.
- Bulk selection in the contact sheet with batch favorite/rating updates and quick copy/move actions.
- Crop preview, crop copy, crop overwrite, rotation preview/save, high-quality scaled export, and a
  retryable background edit queue for crop/scale jobs.
- Configurable quick destination folders, external-editor launch, reveal in file manager, copy to
  clipboard, and move to trash.
- Projector mode that opens a synced fullscreen secondary window for second-display review.
- EXIF/file info panel with XMP sidecar support for RAW workflows.
- Settings for theme, default fit mode, slideshow behavior, folder auto-refresh, window bounds,
  projector behavior, performance mode, recent folders, quick destinations, and external editor.
- Format-support diagnostics, generated-cache controls, performance telemetry overlay, and support
  snapshot export.
- Built-in update checks through the Tauri updater plugin.

## Format Support

LightFrame scans and works with common image formats:

- Standard formats: JPEG, PNG, WebP, GIF, BMP, TIFF/TIF, AVIF, and SVG.
- HEIC/HEIF: metadata, previews, thumbnails, and deep-zoom detail use Windows Imaging Component when
  the matching Windows codecs are installed. Without native support, LightFrame falls back to browser
  rendering or clear placeholders where appropriate.
- RAW review files: DNG, CR2, CR3, NEF, NRW, ARW, SRF, SR2, RAF, ORF, RW2, PEF, and SRW appear in
  scanned folders. On Windows, previews and thumbnails are attempted through native codecs; XMP
  sidecar metadata is shown in the info panel when available.

Full-detail rendering is intentionally conservative for formats that are expensive or unsafe to
decode at original size. In those cases the app prefers generated previews, placeholders, or tiled
paths when supported.

## Installation

Windows builds are published from tagged releases as draft GitHub releases. Download the latest
Windows installer from the [Releases page](../../releases) when a release has been published.

Because LightFrame is a newer open-source Windows app, Windows SmartScreen may show a "Windows
protected your PC" warning. Choose **More info** and then **Run anyway** if you trust the build.

## Development

Prerequisites:

- Node.js 24
- pnpm 10.33.2
- Rust stable
- Tauri desktop prerequisites for your operating system

Install and run the app locally:

```bash
pnpm install
pnpm tauri dev
```

Run the frontend-only dev server:

```bash
pnpm dev
```

Build the frontend:

```bash
pnpm run build
```

Build a Tauri application package:

```bash
pnpm tauri build
```

## Quality Gates

Frontend checks:

```bash
pnpm run format:check
pnpm run lint
pnpm run test:run
pnpm run build
pnpm run quality:audit:ci
```

Rust checks:

```bash
pnpm run ci:rust
```

Full local CI:

```bash
pnpm run ci:local
```

The repository installs local git hooks with `pnpm install`. The pre-commit hook runs
`pnpm run commit:gate`, and the commit-msg hook enforces Conventional Commit messages.

## Project Structure

- `src/` contains the React app, Zustand stores, hooks, UI components, image loading, curation,
  editing queue, telemetry, and tests.
- `src-tauri/` contains the Tauri shell, Rust commands, folder watching, native Windows codec
  integration, generated asset caches, image editing operations, and Rust tests.
- `.github/workflows/ci.yml` runs frontend and Rust quality gates for pushes and pull requests to
  `main`.
- `.github/workflows/release.yml` builds draft Windows releases from version tags.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and contribution guidance.

## License

LightFrame is licensed under the MIT License. See [LICENSE](LICENSE) for details.
