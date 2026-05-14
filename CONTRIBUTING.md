# Contributing to LightFrame

First off, thank you for considering contributing to LightFrame! It's people like you that make open-source software such a great community.

## Development Setup

1. Make sure you have [Node.js](https://nodejs.org/), [pnpm](https://pnpm.io/), and [Rust](https://www.rust-lang.org/) installed.
2. Fork and clone the repository.
3. Run `pnpm install` to install frontend dependencies.
4. Run `pnpm tauri dev` to launch the development environment.

## Code Standards

- **TypeScript / React**: We use Prettier, ESLint, strict TypeScript, React Hooks linting, and
  Vitest. A pre-commit hook now runs `pnpm run commit:gate`, which fetches `origin/main` if needed
  and then runs the full frontend gate locally before the commit is created. You can also run
  `pnpm run ci:frontend` manually before pushing frontend changes.
- **Commit messages**: A `commit-msg` hook enforces Conventional Commits. Use messages like
  `feat(viewer): add direction-aware preload scheduling` or `fix(cache)!: invalidate stale previews`.
  Merge commits, reverts, and `fixup!` / `squash!` commits are allowed through unchanged.
- **Rust**: We use standard Rust formatting, Clippy with warnings denied, and Rust tests. Run
  `pnpm run ci:rust` before pushing Tauri/Rust changes.
- **Changed-code audit**: `pnpm run quality:audit` runs Fallow against the current branch, while
  `pnpm run quality:audit:ci` matches the GitHub Actions base of `origin/main`.
- **Full local gate**: Run `pnpm run ci:local` before pushing broad or release-bound changes. This
  is the closest local equivalent of GitHub Actions.
- **Quality backlog**: `pnpm run quality:dead-code`, `pnpm run quality:dupes`, and
  `pnpm run quality:health` intentionally report existing debt. Use them when planning cleanup work;
  they are not part of the merge-blocking local gate yet.

## Submitting a Pull Request

1. Create a new branch: `git checkout -b feature/your-feature-name`
2. Commit your changes with Conventional Commit messages.
3. Push to your fork and submit a PR against the `main` branch.
4. Run `pnpm run ci:local` if the change is broad, then ensure all CI checks (GitHub Actions) pass.

## Releasing a New Version

LightFrame uses GitHub Actions to automatically build and publish Windows installers. When it is time to release a new version, follow these steps:

1. **Bump Version Numbers**: Create a new branch and update the version number (e.g., from `0.1.0` to `0.2.0`) in the following three files:
   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
2. **Merge to Main**: Commit these changes, open a Pull Request, and merge it into the `main` branch.
3. **Trigger the Release**: Pull the latest `main` branch locally, then tag and push:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
4. **Publish the Draft**: The GitHub Action will automatically spin up, read the version from `tauri.conf.json`, and compile the `.msi` and `.exe` installers. **Note:** It will attach these installers to a **Draft** release on GitHub to give you time to write release notes. You must navigate to the GitHub Releases page and click "Publish release" to make the installer visible to the public.
   - _Alternatively, publish via CLI:_ `gh release edit app-v0.2.0 --draft=false`
