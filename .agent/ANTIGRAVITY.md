# Agent Workflow For LightFrame

The LightFrame repository keeps agent guidance in `AGENTS.md` and `.agent/` so human and AI
contributors run the same scoped implementation, review, and quality gates before pushing.

## The Architecture

Antigravity operates securely through a system of strict context boundaries based around:

1. **Repository scripts**: `package.json` is the source of truth for local and CI quality gates.
2. **Workflows (`.agent/workflows/*`)**: Repeatable instructions for running the right validation
   command for the changed scope.
3. **Skills (`.agent/skills/*`)**: Focused review and test-selection guidance for AI-assisted work.
4. **Orchestration (`.agent/orchestration/*`)**: The state machine and role contracts for one task
   from specification through PR and CI.
5. **Runtime state (`.agent/runtime/*`)**: Local, ignored recovery state managed by
   `scripts/agent-task.mjs`.

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

## Task bootstrap

Use `node scripts/agent-task.mjs start --slug <task-slug> --title "<task title>" --spec-file <path>`
to fetch `origin/main`, verify the source checkout is clean, and create an isolated
`codex/<task-slug>` worktree. The command refuses to stash, reset, or overwrite existing changes
and records the specification hash when `--spec-file` is provided.

Use the same command's `transition`, `record-review`, `record-pr`, `show`, and `close` subcommands
to persist the state-machine position and make interruption recovery explicit. The orchestrator remains
responsible for spawning agents, running checks, and verifying GitHub status; the script provides
the safe branch/worktree and state primitives.

When authoring new constraints, prefer updating a focused workflow or skill and keeping the command
it references available in `package.json`.
