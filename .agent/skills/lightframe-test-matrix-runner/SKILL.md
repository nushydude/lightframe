---
name: lightframe-test-matrix-runner
description: Select the smallest responsible validation commands based on changed scope.
---

# LightFrame Test Matrix Runner

Use this workflow to choose fast iteration checks and the final push-readiness gate.

## Selection Rules

1. Identify changed areas:
   - `src/**/*.ts` or `src/**/*.tsx`: frontend behavior, React state, hooks, services, or tests.
   - `src-tauri/**`: Rust/Tauri commands, permissions, packaging, or native image processing.
   - `.github/**`, `package.json`, `pnpm-lock.yaml`, `.fallowrc.json`, `eslint.config.js`: quality
     or CI infrastructure.
   - broad/high-risk: cross-cutting changes touching multiple areas.
2. Prefer fast commands while iterating:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm run test:run`
   - `pnpm run quality:audit`
3. Before push readiness:
   - frontend-only: `pnpm run ci:frontend`
   - Rust/Tauri-only: `pnpm run ci:rust`
   - broad/high-risk: `pnpm run ci:local`

## Quality Backlog Commands

These commands intentionally surface existing debt and may fail until cleanup work is planned:

- `pnpm run quality:dead-code`
- `pnpm run quality:dupes`
- `pnpm run quality:health`

## Output Contract

Report commands and outcomes in this format:

- `<command>`: passed/failed
- `skips`: explicit reason
- `next required check`: command or `none`
