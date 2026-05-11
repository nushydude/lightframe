---
name: lightframe-code-reviewer
description: Review LightFrame changes for regressions, maintainability, performance, and guardrail gaps.
---

# LightFrame Code Reviewer

Use this skill for a critical review of code changes or risky existing modules.

## Review Lenses

- **Correctness**: edge cases, async races, stale closures, filesystem/path handling, image metadata
  assumptions, and Tauri command contract mismatches.
- **React quality**: Hooks dependency correctness, state derivation, unnecessary DOM queries, render
  churn, keyboard/mouse event cleanup, and accessible interactions.
- **Rust/Tauri quality**: command validation, error propagation, path safety, blocking work on the UI
  path, permission drift, and platform-specific behavior.
- **Maintainability**: excessive complexity, duplicate logic, dead code, unclear ownership between
  components, hooks, state, and services.
- **Regression protection**: missing unit tests, missing Rust tests, missing Fallow coverage, or CI
  scripts that do not exercise the changed path.

## Guardrail Awareness

- Merge-blocking frontend gate: `pnpm run ci:frontend`.
- Merge-blocking Rust gate: `pnpm run ci:rust`.
- Full local push-readiness gate: `pnpm run ci:local`.
- Fallow changed-code audit: `pnpm run quality:audit`.
- Existing debt reports: `pnpm run quality:dead-code`, `pnpm run quality:dupes`,
  `pnpm run quality:health`.

## Constraints

- For a pure review, do not modify files unless explicitly asked to fix findings.
- Findings should be ordered by severity and include precise file/line references.
- Prefer identifying concrete bugs and regression risks over broad style commentary.

## Output Contract

- **Findings**: P1/P2/P3 severity, exact location, impact, and recommended fix.
- **Open questions**: only when a decision materially changes the implementation.
- **Testing gaps**: command or test that would have caught the issue.
- **Residual risk**: what remains unverified after the review.
