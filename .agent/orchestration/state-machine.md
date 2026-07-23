# LightFrame Roadmap Task State Machine

This state machine controls one user task from specification through PR delivery and merge cleanup.
The orchestrator must not skip states, and must persist the current state with
`scripts/agent-task.mjs` so an interrupted run can resume without duplicating work.

## State List

### TASK_SELECTED

Entry criteria:

- Exactly one user task is selected.
- User has not requested a combined task.

Actions:

- Read the task plan when one exists, otherwise derive a short specification from the user prompt.
- Read current `git status --short`.
- Identify likely files from the task plan.

Exit to:

- `BLOCKED_DIRTY_WORKTREE` if unrelated user changes make the task unsafe.
- `SPECIFYING` if the task can be scoped safely.

### SPECIFYING

Entry criteria:

- The task prompt has been accepted as one scoped change.

Actions:

- Record the goal, acceptance criteria, constraints, affected areas, test plan, and open decisions.
- Ask the user only about decisions that materially change the implementation.
- Do not start coding until the specification is sufficient to review.

Exit to:

- `BRANCH_READY` after the isolated worktree is created from freshly fetched `origin/main`.
- `AUTHORIZATION_REQUIRED` only when the task is complete and delivery authorization is the only
  remaining decision.

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

- Run `node scripts/agent-task.mjs start --slug <task-slug> --title "<task title>" --spec-file <path>`.
- Confirm the branch is `codex/<task-slug>`, the recorded base SHA is from `origin/main`, and the
  specification hash is present when a spec file was used.
- Do not use a dirty source checkout or carry unrelated changes into the task worktree.

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
- Record the independent reviewer result with
  `node scripts/agent-task.mjs record-review --slug <task-slug> --status APPROVED|CHANGES_REQUESTED`.
- Reviewer returns `APPROVED` or `CHANGES_REQUESTED`.

Exit to:

- `REMEDIATING_REVIEW` if reviewer returns `CHANGES_REQUESTED`.
- `PR_READY` if reviewer returns `APPROVED`.
- `AUTHORIZATION_REQUIRED` if reviewer approval and local gates pass but delivery is not authorized.

### REMEDIATING_REVIEW

Entry criteria:

- Reviewer requested changes.

Actions:

- Send reviewer checklist to the GPT 5.5 medium implementation agent.
- Implementation agent fixes requested items only.
- Run checks named by reviewer and local gates as needed.

Exit to:

- `REVIEWING`.

### AUTHORIZATION_REQUIRED

Entry criteria:

- The implementation is reviewed and locally verified, but the user has not explicitly authorized
  commit, push, and PR creation.

Actions:

- Report the exact branch, changed files, check results, reviewer result, and intended PR target.
- Wait for explicit delivery authorization. Do not commit, push, open, merge, or force-push.

Exit to:

- `PR_READY` after authorization is received.
- `ABANDONED` if the user stops the task.

### PR_READY

Entry criteria:

- Reviewer approved.
- Local gates pass.
- Worktree contains only intended task changes.

Actions:

- Create commit with a clear message.
- Push branch.
- Open PR.
- Record the PR URL and head SHA with `node scripts/agent-task.mjs record-pr ...`.

Exit to:

- `PIPELINE_WAIT`.

### PIPELINE_WAIT

Entry criteria:

- PR exists.

Actions:

- Poll GitHub Actions for the exact recorded PR head SHA, not merely the branch name.
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
- Wait for the user to merge the PR.
- Remove the merged task worktree once the merge is confirmed.
- Confirm the primary worktree is back on `main`.

### ABANDONED

Entry criteria:

- User explicitly stops the task.

Actions:

- Leave worktree in a clear state.
- Report what was changed and what remains.

## Allowed Transitions

```text
TASK_SELECTED -> BLOCKED_DIRTY_WORKTREE
TASK_SELECTED -> SPECIFYING
SPECIFYING -> BRANCH_READY
SPECIFYING -> AUTHORIZATION_REQUIRED
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
REVIEWING -> AUTHORIZATION_REQUIRED
REMEDIATING_REVIEW -> REVIEWING
AUTHORIZATION_REQUIRED -> PR_READY
AUTHORIZATION_REQUIRED -> ABANDONED
PR_READY -> PIPELINE_WAIT
PIPELINE_WAIT -> PIPELINE_REMEDIATION
PIPELINE_WAIT -> DONE
PIPELINE_REMEDIATION -> PIPELINE_WAIT
```

Any other transition requires a user decision.
