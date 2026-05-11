---
name: lightframe-antigravity-bootstrap
description: Bootstrap agent sessions with minimal mandatory context and safety checks.
---

# LightFrame Agent Bootstrap

Use this startup workflow before implementation.

## Workflow

1. Read `.agent/ANTIGRAVITY.md`.
2. Run `git status --short` and identify the current branch.
3. Stay on the current branch unless the user explicitly asks to switch.
4. Classify the task scope:
   - frontend: `src/**`
   - Rust/Tauri: `src-tauri/**`
   - quality/CI: `package.json`, `pnpm-lock.yaml`, `.github/**`, `.fallowrc.json`,
     `eslint.config.js`, `.prettierrc`, `.prettierignore`
   - docs/agent guidance: `README.md`, `CONTRIBUTING.md`, `.agent/**`
5. Before edits, state the planned files and the required validation command.
6. After edits, run the smallest responsible gate:
   - frontend-only: `pnpm run ci:frontend`
   - Rust/Tauri-only: `pnpm run ci:rust`
   - broad/high-risk: `pnpm run ci:local`

## Output Contract

Return this block before code edits:

- `Scope`
- `Planned files`
- `Required checks`
- `Unrelated changes`: whether any were detected
