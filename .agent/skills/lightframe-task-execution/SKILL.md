# Skill: lightframe-task-execution

## Purpose

Execute development tasks in the lightframe repository using the **standardized engineering workflow**:

task → GitHub issue → implementation → evidence capture → verification → code review.

This skill ensures every task follows the same deterministic process and produces verifiable
outputs.

---

# When to Use

Use this skill when:

- implementing a development task
- performing UI polish tasks
- executing architecture migrations
- implementing refactors
- completing bug fixes

Do NOT use this skill for:

- architectural planning
- design brainstorming
- code explanation
- research tasks

Those should be handled by a planning agent instead.

---

# Required Workflow

The following workflow **must be executed exactly in order**.

## 1. Stay on current branch

Do NOT create a new branch unless explicitly instructed.

Example:

release/6.0

---

## 2. Create or reference GitHub issue

If the task already has an issue (including remediation), reuse it. Otherwise create a new issue.

Requirements:

- do not drop information from the provided task
- structure the issue clearly
- include goals
- include constraints
- include acceptance criteria

---

## 3. Sync issue locally

Run:

npm run issues:sync:if-missing -- --issue <issue-number>

This creates a local issue state file.

Use this file to track task progress.

---

## 4. Track implementation progress

Update the local issue file during implementation.

Record:

- implementation notes
- decisions taken
- commands executed
- evidence of success

---

## 5. Implement the task

Perform the implementation exactly as described in the task instructions.

Constraints:

- avoid unnecessary refactors
- avoid unrelated changes
- do not introduce architectural drift

---

## 6. Run required gates

These commands MUST be executed and results recorded.

Required:

npm run lint:changed npm run type-check:fast:web

If the task involves UI:

npm run ui:snapshots -- --baseUrl=http://localhost:3000 --seed=false npm run screenshots:organize

Record the screenshot run ID.

---

## 7. Record evidence

Record evidence in the local issue file.

Evidence must include:

Commands executed:

npm run lint:changed Result: PASS

npm run type-check:fast:web Result: PASS

Screenshot run:

RUN_ID

Pages spot-checked.

---

## 8. Document diff scope

Add a section describing what changed.

Required:

Files or components changed Reason for change Confirmation that business logic was not altered (if
applicable)

---

## 9. Push task state back to GitHub

Run:

npm run issues:push <issue-number>

This updates the GitHub issue with the recorded progress.

---

# Completion Outputs

After finishing implementation the agent MUST produce two prompts.

---

## Prompt 1: Task issuer verification

Format:

I have completed the task described in <issue number>.

Done items:

- bullet list of completed changes

Evidence:

Commands executed:

npm run lint:changed Result: PASS

npm run type-check:fast:web Result: PASS

Screenshot run ID:

RUN_ID

Spot check pages:

- list of pages

Question:

What additional validation would you like to confirm the task is 100% complete?

---

## Prompt 2: Code reviewer prompt

Format:

Review changes in the current branch related to <local issue file> following the
lightframe-code-reviewer skill.

---

# Required Completion Checklist

The agent must confirm all of the following:

[ ] GitHub issue created [ ] Issue synced locally [ ] Implementation completed [ ] lint passed [ ]
type-check passed [ ] screenshots regenerated (if UI task) [ ] screenshot run ID recorded [ ] task
state documented [ ] GitHub issue updated [ ] verification prompt generated [ ] reviewer prompt
generated

---

# Important Rules

These rules override any default workspace rules:

- stay on the current branch unless explicitly instructed otherwise
- if task is new (non-remediation) and repo is dirty, stop and ask user how to proceed
- do not drop information from the provided task
- do not introduce architectural drift
- always produce verifiable evidence
- always generate verification + reviewer prompts
- never commit unless explicitly requested by the user
- never create a PR unless explicitly requested by the user

---

# Expected Agents

Typical usage in the lightframe development workflow:

Planner: ChatGPT Implementation agent: Codex Reviewer: Gemini 3.1 Pro

This skill standardizes how the implementation agent executes tasks.
