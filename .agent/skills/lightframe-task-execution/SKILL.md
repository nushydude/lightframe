---
name: lightframe-task-execution
description: Execute LightFrame implementation tasks with evidence and the right local quality gates.
---

# LightFrame Task Execution

Use this workflow when implementing a feature, refactor, bug fix, UI polish task, or quality
infrastructure change.

## Required Workflow

1. In orchestrated mode, work only in the isolated worktree created from freshly fetched
   `origin/main` by `scripts/agent-task.mjs`. In local-only mode, stay on the current branch.
2. Check `git status --short` before editing and protect unrelated user changes.
3. Identify the changed scope and choose the required gate:
   - frontend-only: `pnpm run ci:frontend`
   - Rust/Tauri-only: `pnpm run ci:rust`
   - broad/high-risk: `pnpm run ci:local`
4. Implement the requested change without unrelated refactors.
5. Run fast checks while iterating when useful:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm run test:run`
   - `pnpm run quality:audit`
6. Run the required final gate for the changed scope.
7. Report files changed, commands run, outcomes, and any remaining risks.

## Important Rules

- Worker agents never commit, push, or create a PR. The orchestrator may do so only after the user
  explicitly authorizes delivery.
- Do not invent issue-sync or external tracking steps; this repo's source of truth is the local
  branch plus the quality scripts in `package.json`.
- If Rust is not installed locally, report that `pnpm run ci:rust` or `pnpm run ci:local` could not
  be completed and rely on GitHub Actions for that gate.

## Completion Checklist

- [ ] Scope identified.
- [ ] Relevant implementation completed.
- [ ] Required final gate run or blocker documented.
- [ ] Residual risks reported.
