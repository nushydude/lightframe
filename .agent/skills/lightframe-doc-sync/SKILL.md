---
name: lightframe-doc-sync
description: Keep developer and Help Center docs aligned with behavior changes.
---

# lightframe Doc Sync (Codex + AntiGravity)

## Contract

- Input: a concrete change set (PR/branch/commit) OR a described feature/bugfix.
- Output: a minimal checklist of doc updates + the exact edits required.
- Privacy: Help Center content must NOT include file paths, internal component names, or engineering
  jargon.

## Token Budget Mode

Default to **TINY** output.

### TINY output (default)

Return ONLY:

- A checklist of files to update (bulleted)
- For each file: 1–3 specific change bullets

No commentary, no analysis, no duplicated content.

### NORMAL output (only if user asks)

Add <= 8 lines explaining rationale and where you looked.

## Deterministic Rules

### Scope gate (avoid unnecessary work)

- If the change is purely internal and does NOT affect:
  - user-visible UI text/controls,
  - workflows (steps users take),
  - calculations/logic users observe,
  - APIs used by clients, then DO NOT update Help Center content.

### Sources of truth

1. Help Center article source (in-app): `apps/web/src/content/help/*.md` (update article bodies
   here)
2. Help Center map loader (in-app): `apps/web/src/utils/helpArticleContentMap.ts` (thin aggregator;
   usually no content edits needed)
3. Help Center registry (only if adding/removing article entries):
   `apps/web/src/components/Pages/HelpCenter.tsx`
4. Context wiring (only if article relevance changes): `apps/web/src/utils/helpArticleMapping.ts`
   and `helpCenterContext` usage in relevant page headers
5. User guide docs (canonical docs): relevant `docs/*.md` guides (use `docs/user-guides/*` only if
   that directory exists)
6. Developer/task docs: `docs/tasks/**` as needed

### Tone and wording constraints (Help Center)

- Friendly, concise, non-technical.
- Avoid: “refactor”, “schema”, “API”, “component”, “hook”, “PR”, file paths, internal names.
- Focus on: what changed, what the user should do, what to expect.

## Execution Steps (must follow order)

0. Apply Token Budget Mode: use TINY output unless user explicitly requests NORMAL.

1. Classify change impact:
   - UI-only
   - Workflow change
   - Calculation/behavior change
   - API/client contract change
   - Internal-only

2. Decide which doc surfaces must change:
   - If UI/workflow/calculation changed → Help Center article update required.
   - If architecture/standards/contracts changed → developer docs update required.
   - If both → update both.

3. Help Center update path (only if required):
   - Step A: update/create canonical guide in relevant `docs/*.md` guide files
   - Step B: update/create in-app article markdown in `apps/web/src/content/help/*.md`
   - Step C: if NEW article only, register metadata in
     `apps/web/src/components/Pages/HelpCenter.tsx`
   - Step D: only touch `helpArticleContentMap.ts` when loader behavior changes

4. Contextual wiring (only if required):
   - Identify relevant page context (`helpCenterContext` passed to `PageHeader`).
   - Ensure mapping includes the article ID(s) in `apps/web/src/utils/helpArticleMapping.ts`.

5. Verification checklist:
   - Article renders in Help Center modal.
   - Internal links like `[text](#article-id)` resolve.
   - Every article in `HelpCenter.tsx` has matching `apps/web/src/content/help/<article-id>.md`.
   - Content matches the shipped behavior.

## Output Format (TINY)

- Files to update:
  - <file>
    - <change bullet>
    - <change bullet>

## Hard Constraints

- NEVER invent new articles unless explicitly required.
- NEVER update Help Center for internal-only changes.
- ALWAYS update in-app article markdown at `apps/web/src/content/help/*.md` when Help Center text
  changes.
- KEEP `helpArticleContentMap.ts` as a loader/aggregator (do not reintroduce monolithic inline
  article content).
- ALWAYS keep user-facing and developer docs consistent with the shipped behavior.
