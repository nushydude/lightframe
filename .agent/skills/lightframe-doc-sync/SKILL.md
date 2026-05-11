---
name: lightframe-doc-sync
description: Keep developer docs and agent guidance aligned with behavior or workflow changes.
---

# LightFrame Doc Sync

Use this skill when a change affects user-visible behavior, developer workflow, CI, quality gates, or
agent instructions.

## Scope Gate

- If the change is purely internal and does not affect behavior, workflow, commands, or contributor
  expectations, no doc update is required.
- If quality scripts, CI, or local checks change, update `CONTRIBUTING.md` and relevant `.agent/**`
  workflows or skills.
- If user-facing behavior changes, update `README.md` or another existing user-facing document when
  one clearly applies.

## Current Documentation Surfaces

- Contributor workflow: `CONTRIBUTING.md`
- Agent workflow: `.agent/ANTIGRAVITY.md`
- Compliance gate: `.agent/workflows/check-compliance.md`
- Skill-specific guidance: `.agent/skills/*/SKILL.md`
- Product overview: `README.md`

## Output Contract

- Files to update:
- Verification command:
- Reason no docs are needed, if skipped:
