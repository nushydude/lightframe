# LightFrame Roadmap Task State Machine

This state machine controls one roadmap task from selection through green pipeline. The orchestrator
must not skip states.

## State List

### TASK_SELECTED

Entry criteria:

- Exactly one `.agent/roadmap/tasks/*.md` file is selected.
- User has not requested a combined task.

Actions:

- Read the task plan.
- Read current `git status --short`.
- Identify likely files from the task plan.

Exit to:

- `BLOCKED_DIRTY_WORKTREE` if unrelated user changes make the task unsafe.
- `BRANCH_READY` if safe to continue.

### BLOCKED_DIRTY_WORKTREE

Entry criteria:

- Worktree contains unrelated changes that conflict with the selected task.

Actions:

- Ask the user whether to continue, stash, or use a new worktree.
- Do not modify conflicting files.

Exit to:

- `BRANCH_READY` after the user resolves or authorizes a safe path.

### BRANCH_READY

Entry criteria:

- Worktree is safe for this task.

Actions:

- Create or switch to `codex/<task-slug>`.
- Confirm branch is current.

Exit to:

- `IMPLEMENTING`.

### IMPLEMENTING

Entry criteria:

- GPT 5.5 medium implementation agent has received the task plan and constraints.

Actions:

- Implementation agent edits files and adds tests.
- Orchestrator monitors scope and prevents unrelated changes.

Exit to:

- `IMPLEMENTATION_FAILED` if the implementation agent reports a blocker.
- `LOCAL_CHECKS` when implementation claims complete.

### IMPLEMENTATION_FAILED

Entry criteria:

- Implementation cannot continue without a decision.

Actions:

- Orchestrator inspects blocker.
- If the blocker is technical and solvable, provide more context to implementation agent.
- If it is product/scope ambiguity, ask user.

Exit to:

- `IMPLEMENTING` after blocker is resolved.
- `ABANDONED` only if user stops the task.

### LOCAL_CHECKS

Entry criteria:

- Implementation agent reports code complete.

Actions:

- Run task-specific checks.
- Run full local gates:
  - `pnpm build`
  - `pnpm test -- --run`
  - `cargo fmt -- --check` in `src-tauri`
  - `cargo clippy -- -D warnings` in `src-tauri`
  - `cargo test` in `src-tauri`

Exit to:

- `REMEDIATING_LOCAL_FAILURES` if checks fail.
- `REVIEWING` if checks pass.

### REMEDIATING_LOCAL_FAILURES

Entry criteria:

- One or more local checks failed.

Actions:

- Send exact failing command and relevant log excerpt to the GPT 5.5 medium implementation agent.
- Implementation agent fixes only code-caused failures.
- Rerun failed checks, then full gates if the fix touches shared behavior.

Exit to:

- `LOCAL_CHECKS`.

### REVIEWING

Entry criteria:

- Local checks pass.

Actions:

- Send task plan, diff summary, and check results to GPT 5.5 reviewer.
- Reviewer returns `APPROVED` or `CHANGES_REQUESTED`.

Exit to:

- `REMEDIATING_REVIEW` if reviewer returns `CHANGES_REQUESTED`.
- `PR_READY` if reviewer returns `APPROVED`.

### REMEDIATING_REVIEW

Entry criteria:

- Reviewer requested changes.

Actions:

- Send reviewer checklist to the GPT 5.5 medium implementation agent.
- Implementation agent fixes requested items only.
- Run checks named by reviewer and local gates as needed.

Exit to:

- `REVIEWING`.

### PR_READY

Entry criteria:

- Reviewer approved.
- Local gates pass.
- Worktree contains only intended task changes.

Actions:

- Create commit with a clear message.
- Push branch.
- Open PR.

Exit to:

- `PIPELINE_WAIT`.

### PIPELINE_WAIT

Entry criteria:

- PR exists.

Actions:

- Poll GitHub Actions for the PR head SHA.
- Inspect failed jobs if any.

Exit to:

- `PIPELINE_REMEDIATION` if checks fail.
- `DONE` if all required checks pass.

### PIPELINE_REMEDIATION

Entry criteria:

- GitHub Actions failed.

Actions:

- Fetch failed job logs.
- Send failure summary to the GPT 5.5 medium implementation agent.
- Fix, run local gates, commit, push.
- Send changed diff to GPT 5.5 if behavior changed.

Exit to:

- `PIPELINE_WAIT`.

### DONE

Entry criteria:

- PR is open.
- Reviewer approved.
- Local checks pass.
- Required GitHub Actions checks pass.

Actions:

- Report PR URL, branch, checks, and any follow-up.

### ABANDONED

Entry criteria:

- User explicitly stops the task.

Actions:

- Leave worktree in a clear state.
- Report what was changed and what remains.

## Allowed Transitions

```text
TASK_SELECTED -> BLOCKED_DIRTY_WORKTREE
TASK_SELECTED -> BRANCH_READY
BLOCKED_DIRTY_WORKTREE -> BRANCH_READY
BRANCH_READY -> IMPLEMENTING
IMPLEMENTING -> IMPLEMENTATION_FAILED
IMPLEMENTING -> LOCAL_CHECKS
IMPLEMENTATION_FAILED -> IMPLEMENTING
IMPLEMENTATION_FAILED -> ABANDONED
LOCAL_CHECKS -> REMEDIATING_LOCAL_FAILURES
LOCAL_CHECKS -> REVIEWING
REMEDIATING_LOCAL_FAILURES -> LOCAL_CHECKS
REVIEWING -> REMEDIATING_REVIEW
REVIEWING -> PR_READY
REMEDIATING_REVIEW -> REVIEWING
PR_READY -> PIPELINE_WAIT
PIPELINE_WAIT -> PIPELINE_REMEDIATION
PIPELINE_WAIT -> DONE
PIPELINE_REMEDIATION -> PIPELINE_WAIT
```

Any other transition requires a user decision.
