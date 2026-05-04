# Contributing to LightFrame

First off, thank you for considering contributing to LightFrame! It's people like you that make open-source software such a great community.

## Development Setup

1. Make sure you have [Node.js](https://nodejs.org/), [pnpm](https://pnpm.io/), and [Rust](https://www.rust-lang.org/) installed.
2. Fork and clone the repository.
3. Run `pnpm install` to install frontend dependencies.
4. Run `pnpm tauri dev` to launch the development environment.

## Code Standards

- **TypeScript / React**: We use Prettier for code formatting. Run `pnpm format` (or configure your editor) before committing.
- **Rust**: We use standard Rust formatting. Run `cargo fmt` and `cargo clippy` before submitting your PR.
- **Tests**: If you add a new feature, please add a unit test! Run `pnpm test` to ensure tests are passing.

## Submitting a Pull Request

1. Create a new branch: `git checkout -b feature/your-feature-name`
2. Commit your changes with descriptive commit messages.
3. Push to your fork and submit a PR against the `main` branch.
4. Ensure all CI checks (GitHub Actions) pass.
