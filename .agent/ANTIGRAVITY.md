# Agent Workflow For LightFrame

The LightFrame repository keeps agent guidance in `.agent/` so human and AI contributors run the
same quality gates before pushing.

## The Architecture

Antigravity operates securely through a system of strict context boundaries based around:

1. **Repository scripts**: `package.json` is the source of truth for local and CI quality gates.
2. **Workflows (`.agent/workflows/*`)**: Repeatable instructions for running the right validation
   command for the changed scope.
3. **Skills (`.agent/skills/*`)**: Focused review and test-selection guidance for AI-assisted work.

## Skill Registry

Agents can use the specialized skills in the `.agent/skills` folder:

- `"Use lightframe-test-matrix-runner"` (Runs optimal test commands across the suite)
- `"Use lightframe-code-reviewer"` (Reviews changes for bugs, maintainability, and regression risk)
- `"Use lightframe-task-execution"` (Orchestrates implementation tasks and minimal coding)
- `"Use lightframe-doc-sync"` (Updates documentation and specs after code changes)

## Required Gates

- Frontend-only: `pnpm run ci:frontend`
- Rust/Tauri-only: `pnpm run ci:rust`
- Broad/high-risk/push-readiness: `pnpm run ci:local`

When authoring new constraints, prefer updating a focused workflow or skill and keeping the command
it references available in `package.json`.
