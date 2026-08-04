# LightFrame

LightFrame is a fast, Windows-first desktop image viewer and photo review app built with
[Tauri v2](https://v2.tauri.app/), [React](https://react.dev/), and Rust. It focuses on quick
startup, responsive keyboard navigation, large-folder review, and practical curation tools without
turning the viewer into a full photo manager.

`package.json` is the single declared app-version source. `pnpm run quality:version` verifies it
against the native package, Tauri configuration, and the root `lightframe` package record in
`src-tauri/Cargo.lock`.

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
  projector behavior, performance mode, update channel, recent folders, quick destinations, and
  external editor.
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
  scanned folders and direct-open surfaces, including Windows file associations. On Windows,
  previews and thumbnails are attempted through native codecs; XMP sidecar metadata is shown in the
  info panel when available. `supported-image-extensions.json` is the canonical direct-open list.

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

Run native desktop behavior locally:

```bash
pnpm install
pnpm tauri dev
```

Run the frontend-only dev server:

```bash
pnpm dev
```

`pnpm dev` is a safe UI-development surface. It displays a deterministic synthetic catalog and
labels itself as demo mode; it cannot read files, use drag/drop, run updates, restart the process,
reveal files, or perform destructive actions. Use `pnpm tauri dev` whenever native behavior is
needed.

Build the frontend:

```bash
pnpm run build
```

Build a Tauri application package:

```bash
pnpm tauri build
```

Run the Windows packaged-startup smoke test after building an unpackaged release executable:

```powershell
pnpm tauri build --no-bundle --ci
pnpm run smoke:windows
```

Run the automated Windows Tauri CDP harness (Windows, WebView2 remote debugging support, and a built `lightframe.exe` required):

```powershell
pnpm run e2e:windows
```

The harness isolates its profile and temporary image fixtures, then exercises home startup, folder
startup, navigation/grid, curation persistence after restart, and Settings/Command Palette shortcuts.
Failures write logs, CDP diagnostics, and artifacts under `artifacts/windows-e2e/`.

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

CI also runs a Windows packaged-startup smoke job for pull requests, `main`, and release-work
branches. It builds the release executable, launches it with seeded window-position settings, and
fails if the app exits, never shows a main window, or records a fresh Windows crash event.

Pull requests also run two dependency gates: OSV-Scanner `v2.3.8` checks `pnpm-lock.yaml`, and
RustSec `audit-check@v2.0.0` checks both `src-tauri/Cargo.lock` and
`tools/updater-signature-verifier/Cargo.lock`. Both fail on any detected vulnerability.
Any future exception must include a linked tracking issue, an applicability rationale, and a review-by date next
to the ignore entry. Dependabot owns weekly updates for GitHub Actions, npm, and both Cargo manifests.
The pnpm `esbuild` override keeps Vite 7 on the first patched `0.28.x` release; remove it only when
Vite's declared range includes a non-vulnerable release and the OSV gate remains green.

The repository installs local git hooks with `pnpm install`. The pre-commit hook runs
`pnpm run commit:gate`, and the commit-msg hook enforces Conventional Commit messages.

## Release Channels

Set a release version with one reproducible command; it updates the three declared manifests, asks
Cargo to refresh its lockfile, and validates the result:

```bash
pnpm run version:set -- 8.7.6
pnpm run quality:version
```

Stable releases use tags such as `v8.2.2`. A `v<semver>` tag first checks that the tag exactly
matches every version record, then calls the complete CI workflow from that same tagged commit
(frontend and Rust quality, JavaScript and Rust advisory checks, and Windows packaged-startup
smoke). Only after those jobs pass does the release workflow create the draft Windows release and
verify Tauri's reported artifact version. The app's Stable update channel reads GitHub's latest
published stable updater manifest.

Preview releases use semver prerelease tags such as `v8.3.0-beta.1`. They use the same same-SHA
gate and are created as prerelease drafts; when a maintainer publishes one,
`.github/workflows/preview-channel.yml` copies its
`latest.json` into the fixed `app-preview-channel` prerelease. Users who opt into Preview in
Settings check that manifest instead of the stable `/latest` release.

### Release verification and maintainer setup

Release workflows run in the protected GitHub `release` Environment. Before enabling a public
release, repository maintainers must require reviewers for that environment, restrict custom deployment
branches/tags to the `v*` release-tag policy (with tag protection for `v*`), and store
`TAURI_SIGNING_PRIVATE_KEY` (and its password) only there. Configure Azure
Trusted Signing only when `WINDOWS_SIGNING_PROVIDER=azure-trusted-signing` and its environment-scoped
Azure credentials and account variables are present. Set `REQUIRE_AUTHENTICODE_SIGNING=true` only
after that provider is working: it fails the release evidence check unless every MSI/EXE reports
`Valid`. Without that setting, the workflow reports the actual Authenticode status and does not
represent an unsigned installer as signed; Tauri updater signatures remain required.

Each draft includes `SHA256SUMS.txt`, an SPDX 2.3 SBOM, updater metadata, and GitHub build
provenance. Verify downloaded artifacts before installing:

```powershell
Get-FileHash .\LightFrame_8.7.6_x64-setup.exe -Algorithm SHA256
Get-AuthenticodeSignature .\LightFrame_8.7.6_x64-setup.exe
gh attestation verify .\LightFrame_8.7.6_x64-setup.exe --repo nushydude/lightframe
pnpm run verify:release-artifacts -- --expected-version 8.7.6 --artifact-dir . --checksums .\SHA256SUMS.txt --sbom .\lightframe-8.7.6.spdx.json --require-authenticode true
```

## Project Structure

- `src/` contains the React app, Zustand stores, hooks, UI components, image loading, curation,
  editing queue, telemetry, and tests.
- `src-tauri/` contains the Tauri shell, Rust commands, folder watching, native Windows codec
  integration, generated asset caches, image editing operations, and Rust tests. Curation metadata
  uses 256 incrementally updated shards with a write-ahead journal; legacy `curation.json` data is
  migrated automatically and retained as a backup.
- `.github/workflows/ci.yml` runs frontend, Rust, and Windows packaged-startup quality gates.
- `.github/workflows/release.yml` builds draft Windows stable and prerelease packages from version
  tags.
- `.github/workflows/preview-channel.yml` maintains the opt-in preview updater manifest when a
  prerelease is published.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and contribution guidance.

## License

LightFrame is licensed under the MIT License. See [LICENSE](LICENSE) for details.
