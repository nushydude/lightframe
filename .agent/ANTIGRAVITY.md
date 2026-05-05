# Antigravity For lightframe

The lightframe repository uses **Antigravity** (Google Deepmind's Advanced Agentic Coding Assistant)
alongside dedicated "Skills" to perform sophisticated, reliable, and context-aware reasoning on the
codebase.

## The Architecture

Antigravity operates securely through a system of strict context boundaries based around:

1. **`AGENTS.md`**: The single undisputed root source of truth for runtime operations. Antigravity
   dynamically loads this directly into its `<user_rules>` payload.
2. **Knowledge Items (KIs)**: lightframe tracks its architectural decisions and cross-task learnings in
   summarized Knowledge Items (KIs), which Antigravity evaluates before modifying code or
   researching existing architectural patterns.
3. **Skills (`.agent/skills/*`)**: Custom-tailored workflows designed to limit token bloat and
   provide Antigravity with explicit, repeatable operations for specific tasks (e.g., Code Reviews,
   Test Matrix Execution, PR Creation).

## Skill Registry

Antigravity uses the specialized skills in the `.agent/skills` folder. If you need Antigravity to
perform a highly specific workflow, call the skill directly in your prompt:

- `"Use lightframe-antigravity-bootstrap"` (Standard startup check and context loading)
- `"Use lightframe-test-matrix-runner"` (Runs optimal test commands across the suite)
- `"Use lightframe-code-reviewer"` (Runs multi-stage lint, type, perf, and UX reviews)
- `"Use lightframe-task-execution"` (Orchestrates implementation tasks and minimal coding)
- `"Use lightframe-doc-sync"` (Updates documentation and specs after code changes)

## Global Sync

These skills are synced to your global Antigravity `$HOME` location via:
`scripts/sync-agent-skills.sh --all`

When authoring new constraints or behaviors, prefer editing `AGENTS.md` or creating a highly-focused
Skill rather than polluting unstructured `.md` files in `docs/` that require manual loading.
