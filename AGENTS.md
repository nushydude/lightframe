# LightFrame Agent Contract

This file is the repository-level entry point for Codex and other coding agents. It activates the
workflow described in `.agent/orchestration/` for implementation requests.

## Default implementation lifecycle

When the user asks to implement, fix, refactor, or build a task:

1. Treat the request as one scoped task. Convert it into a short specification with acceptance
   criteria, affected areas, constraints, and required checks. Ask only about decisions that would
   materially change the implementation.
2. Start an isolated task worktree from a freshly fetched `origin/main` by running:

   ```powershell
   node scripts/agent-task.mjs start --slug <task-slug> --title "<task title>" --spec-file <spec-path>
   ```

   Never mix task work with uncommitted user changes in the source checkout. The bootstrap command
   must refuse a dirty source checkout rather than stashing, resetting, or overwriting it. The
   optional `--spec-file` records the specification hash for recovery and review traceability.

3. Use the state machine in `.agent/orchestration/state-machine.md`. Delegate implementation to an
   implementation agent and review to a separate reviewer agent. The implementation agent must not
   approve, commit, push, or open the PR for its own work.
4. Run the task-specific checks, then the required final gate from `.agent/ANTIGRAVITY.md` before
   review and after any remediation that changes code.
5. If review returns `CHANGES_REQUESTED`, pass the exact remediation checklist back to the
   implementation agent, rerun the named checks, and rereview. Stop after three unchanged review
   cycles and ask the user for direction instead of looping indefinitely.
6. Do not declare approval merely because tests pass. The independent reviewer must return the
   exact `APPROVED` status required by the reviewer instructions.
7. Before commit, push, or PR creation, require explicit delivery authorization in the user's
   request or a follow-up message. Local implementation and review may proceed without it; external
   repository mutations may not be inferred from the word "implement" alone.
8. After authorization, the orchestrator—not a worker—creates the scoped Conventional Commit,
   pushes `codex/<task-slug>`, opens the PR against `main`, records the PR URL and head SHA, and
   waits for the actual GitHub checks for that SHA. CI failures return to implementation and review.
9. Do not merge the PR unless the user explicitly asks. After the user confirms merge, use the
   recorded task state to remove the task worktree and fast-forward the primary checkout to
   `origin/main`.

## Repository context

- Read `.agent/ANTIGRAVITY.md` and the applicable files under `.agent/skills/` before editing.
- Use `.agent/orchestration/gpt-5.4-orchestrator-instructions.md` for orchestration behavior,
  `.agent/orchestration/state-machine.md` for transitions, and
  `.agent/orchestration/gpt-5.5-reviewer-instructions.md` for the independent review bar.
- Use `pnpm run ci:frontend` for frontend-only changes, `pnpm run ci:rust` for Rust/Tauri-only
  changes, and `pnpm run ci:local` for broad or high-risk changes.
- Preserve unrelated user changes and do not edit `CONTRIBUTING.md` or unrelated files merely to
  satisfy an implementation task.

## External actions and failure handling

- GitHub authentication, repository permissions, branch protection, and required checks must be
  verified before attempting delivery.
- Never force-push, reset user work, delete branches, or remove a worktree unless the lifecycle state
  and explicit authorization make that action safe.
- Persist orchestration state under `.agent/runtime/` using `scripts/agent-task.mjs`; this directory
  is local runtime state and is not committed.
- If a state transition, check, reviewer decision, or GitHub operation cannot be verified, stop in
  the corresponding state and report the exact blocker.
