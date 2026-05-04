---
name: lightframe-antigravity-bootstrap
description: Bootstrap Antigravity sessions with minimal mandatory context and safety checks.
---

# lightframe Antigravity Bootstrap

Use this startup workflow before implementation in Antigravity.

## Workflow

1. Read `.agent/ANTIGRAVITY.md`.
2. Read `AGENTS.md`.
3. Read required standards:
   - `docs/AI_COMPATIBILITY_RULES.md`

4. Classify task type (`ui | api | types | tests | infra`), then load additional docs conditionally:
   - load `docs/TESTING_MATRIX.md` only for `tests` tasks or when explicitly asked.
   - load `docs/GITHUB_WORKFLOW_PROCESS.md` and `docs/AI_ASSISTANT_GUIDELINES.md` only if the task
     involves branching/PR/commits.
5. Identify the issue number from user request or branch name (e.g., `issue/1234-description`).
6. If issue number is known, sync targeted issue context:
   - `npm run issues:sync:if-missing -- --issue <issue-number>`
7. Read the corresponding task state file:
   - `docs/tasks/open/<issue-number>-<name>.md`
8. Run `git status --short`, `git diff --stat`, and read current branch.
9. Apply branch/dirty-repo gate:
   - if branch matches `release/<x.y>` or `release/<x.y.z>`, stay on current branch.
   - if task is remediation, stay on current branch unless user says otherwise.
   - if task is new (non-remediation) and repo is dirty, stop and ask user how to proceed.
10. Publish a pre-edit change safety check:

- files to modify
- intended behavior change
- explicit no-unrelated-change confirmation

11. For non-trivial tasks, keep `docs/tasks/open/<issue-number>-<name>.md` updated.
12. If task touches Help Center/docs content, activate `lightframe-doc-sync` and follow modular content
    paths:
    - in-app articles: `apps/web/src/content/help/*.md`
    - in-app registry: `apps/web/src/components/Pages/HelpCenter.tsx`
    - canonical docs: `docs/` relevant guides for the changed behavior
13. At task completion, push updated issue state via `npm run issues:push <issue-number>`.

## Output Contract

Return this block before code edits:

- `Platform`: Antigravity
- `Scope`
- `Planned files`
- `Guardrails loaded`
- `Required checks`
