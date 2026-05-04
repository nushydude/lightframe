---
name: lightframe-code-reviewer
description:
  Review code for smells, bugs, performance, maintainability, token efficiency, and
  practicality—real-world gap analysis so solutions work beyond the happy path.
---

# lightframe Code Reviewer

Use this skill to perform a deep technical review of code changes or existing modules. This skill
emphasizes long-term health, performance, and efficiency of the codebase, specifically tailoring for
an AI-augmented development workflow.

## When To Use

- After completing a feature or complex bug fix, but before finalizing the task.
- When explicitly asked to "review", "audit", or "inspect" a piece of code.
- To identify performance bottlenecks or potential bugs in mission-critical logic.
- To optimize files for reduced context bloat (AI Token Optimization).
- To assess whether the solution holds up in real-world scenarios (variable data, imports, multiple
  similar items, edge flows)—not only the happy path.
- For **mission-critical** or **high-assurance** passes: the skill applies Security, Resilience,
  Observability, Data consistency, Audit, and Failure-modes lenses when the change touches auth,
  payments, PII, or core data flows—or ask explicitly to run them on any change.

## Workflow

1.  **Preparation**:
    - Identify the set of files or the specific scope to be reviewed.
    - Check if the task is `ui`, `api`, `types`, or `infra` (see `AGENTS.md`).
    - Load supporting docs only when relevant: listing/tabbed UI →
      `docs/architecture/LISTING_PAGE_ARCHITECTURE.md` and tabbed section header policy; test
      changes → `docs/TESTING_MATRIX.md`.
    - **ADR alignment**: Scan `docs/decisions/index.md` for ADRs that touch the changed area (e.g.
      navigation, listing, forms, API patterns). Read any relevant ADRs and verify the change aligns
      with accepted decisions; flag contradictions or bypasses.
    - If multiple issues are in scope (e.g. 1666 + 1667 + 1770), produce one review per issue or one
      combined review with clearly separated sections and **one remediation file per issue** (append
      rounds to each `docs/tasks/open/<issue-number>-review-remediation.md` as needed).

2.  **Multidimensional Review**: Perform a focused analysis through the following lenses. **For each
    lens, state an explicit conclusion** (e.g. "No issues" / "N/A – not a UI task" / list findings
    with file and line or symbol). Do not skip a lens silently.
    - **Code Smells & Readability**: Identify antipatterns, duplication, or overly complex logic.
      Ensure code is easy to understand.
    - **Potential Bugs**: Check for edge cases, race conditions (in async code), or incorrect
      boundary conditions.
    - **Performance**: Spot inefficient loops, redundant database calls, heavy re-renders in React,
      or unnecessary object allocation.
    - **Stability**: Ensure robust error handling (try/catch), proper state management, and that the
      code fails gracefully.
    - **Maintainability**: Evaluate if the code follows project standards (e.g., lightframe design
      tokens, specific hook patterns).
    - **Architecture Alignment**: Ensure the change respects the monorepo structure (`apps/web`,
      `apps/api`, `packages/shared`) and follows the "Classification First" rule from `AGENTS.md`.
      Verify that logic belongs in the correct package.
    - **ADR Alignment**: Using `docs/decisions/index.md`, identify ADRs that apply to the changed
      area (e.g. listing pages → 0017, 0022; navigation → 0005, 0027; forms/wizards → 0002, 0014).
      Confirm the change does not contradict or bypass an accepted ADR; if it extends or supersedes
      one, note it and consider whether the ADR should be updated or a new one added.
    - **UX Architecture**: (For `ui` tasks) Validate compliance with `UX Rules` in `AGENTS.md`.
      Check Page Intent, structure (Dashboard vs Task vs Insights), and responsive patterns. Ensure
      primary actions are correctly aligned and colored. Optionally note obvious accessibility or
      security gaps (e.g. missing aria labels on critical actions, user input rendered unsanitized).
    - **Data Integrity & Migrations**: (For `api` or schema changes) Check if a formal MongoDB
      migration is required and present (Rule 4 in `AGENTS.md`). Ensure no breaking changes to
      existing data schemas without a migration strategy.
    - **API Integration Tests**: (For `api` tasks or backend behavior changes) Determine whether new
      or updated API integration tests are required. Conclude one of: "N/A – no API behavior
      change", "Covered by existing tests", or "Tests required" with concrete gaps.
      - Ensure tests cover:
        - Authn/authz (allowed vs forbidden) for each affected route.
        - Validation (required fields, bad types, boundary values).
        - Behavioral contract: response status + shape + key side effects (DB writes, events).
        - Error paths (not found, conflict, external dependency failures) where plausible.
      - If endpoints are versioned or have backwards-compat guarantees, confirm the tests protect
        the expected compatibility surface.
      - Prefer adding/adjusting tests close to existing integration suites and patterns; flag when
        changes are only unit-tested but need an integration assertion.
    - **Database seed script quality**: (When changes impact local/dev data, demos, E2E-like flows,
      or reviewer notices seed drift) Assess whether the DB seed script should be improved for the
      change set. If relevant, conclude "Seed: OK" / "Seed: needs work" with gaps.
      - Determinism: same inputs → same outputs (stable IDs/dates where required).
      - Idempotency: re-running should not duplicate entities or should reset cleanly by design.
      - Realism: seed data exercises the new/changed code paths (edge cases included sparingly).
      - Speed: avoid slow N+1 inserts; use bulk operations where appropriate.
      - Safety: no production env footguns; clear guardrails to prevent accidental prod writes.
      - Maintainability: small, composable helpers; no hard-coded magic that’s hard to update.
    - **lightframe anti-patterns** (flag when present; see AGENTS.md and project norms):
      - Use of `any` (types, catch blocks, or casts that could be narrowed).
      - Back navigation via `navigate(-1)` on tabbed/child pages (prefer route-based back; see
        tabbed section header policy).
      - Submitting forms via `document.querySelector('form')` instead of an explicit form ref.
      - Logic in the wrong package (e.g. API-only types in `apps/web`, shared UI constants in
        `apps/api`).
      - **Date / timezone (apps/web)**: User-facing "today" defaults, date chips, and export
        filenames must use the user's timezone when available. Flag: (1) direct imports of `now`,
        `today`, or `formatDateToYYYYMMDD` from `@lightframe/shared` in `apps/web` (prefer
        `dateUtilsTimezone` / `getTzDateString`); (2) `nowInTimezone()` or `todayInTimezone()`
        called with no argument in components or hooks that have access to user context (prefer
        `useUserTimezone()` and pass it in). Instant/timestamp use (logs, correlation IDs, JWTs) is
        out of scope.
    - **AI Token usage optimization**:
      - Suggest removing "noisy" or redundant comments that don't add value.
      - Consolidation of related logic vs. extraction (finding the balance).
      - Identifying dead code or unused imports.
    - **Practicality & Real-World Gap Analysis**:
      - Ask: Does the solution work for real-world usage, or only the happy path?
      - Consider data sources: e.g. CSV/manual import, bulk entry, different amounts (variable vs
        fixed), multiple similar items (grouped or not).
      - Consider user flows: What happens when amounts differ (e.g. electricity bill)? When there
        are many similar transactions? When data comes from import vs manual entry? Is the "correct"
        value (e.g. typical/estimated amount) surfaced or prefilled where needed?
      - If the feature returns or uses aggregates (e.g. typical/min/max), is that shown in the UI
        and used in downstream flows (e.g. convert/link) so the user can set the right value?
      - Record any practical gaps in the remediation file; if they warrant a separate backlog item,
        add a "Follow-up issue" note or create a GH issue and link it.
    - **Mission-critical lenses** (apply when relevant or when requested): When the change touches
      **auth**, **payments**, **PII**, or **core data flows** (e.g. linking expenses to recurring,
      bulk updates, migrations), or when the user explicitly asks for a
      mission-critical/high-assurance review, also apply the lenses in the "Mission-critical /
      high-assurance review" section below. For each that applies, state an explicit conclusion.
      Include a **Mission-critical** subsection in the output whenever these lenses were used.

3.  **Severity for findings**: Classify each finding so remediation can be prioritized:
    - **P1 (Must fix)**: Correctness, security, or data-integrity risk; blocking for merge.
    - **P2 (Should fix)**: Maintainability, type safety, token efficiency, or UX consistency; fix in
      same PR or same remediation round when feasible.
    - **P3 (Nice to have)**: Optional DRY, minor style, or follow-up backlog.

4.  **Refactoring Identification**:
    - **Barrel Pattern**: Check if a directory should use a barrel export (see
      `lightframe-barrel-export-refactor`).
    - **Separation of Concerns**: Suggest extracting logic into hooks, helpers, or services.
    - **Flattening**: Suggest reducing deep nesting or complex conditional chains.

5.  **Test Coverage Check**:
    - Assess whether the current tests adequately cover the new or modified logic. For `tests` or
      test-heavy changes, consider `docs/TESTING_MATRIX.md` and existing patterns.
    - For backend changes, explicitly call out whether **API integration tests** should be added or
      updated (even if unit tests exist). If tests are missing, list the minimal set of integration
      scenarios required to protect the contract.
    - **DO NOT** run unit tests, lint checks, or type checks. This is a purely analytical step.

6.  **Architectural Records (ADR)**:
    - **Existing ADRs**: Alignment with relevant ADRs (see ADR Alignment lens above) must be stated
      in the review; flag any drift or contradiction.
    - **New ADRs**: If the review identifies a significant new architectural pattern or decision
      (e.g. new state management approach, new external dependency, or cross-cutting concern), it
      MUST be recorded in `docs/decisions/`. Use `docs/decisions/template.md` for new ADRs.

7.  **Remediation Task**:
    - If changes are required, DO NOT implement them immediately using this skill.
    - Create or update a deterministic remediation file:
      `docs/tasks/open/<issue-number>-review-remediation.md`
    - If the file exists, append a new `## Remediation Round <n>` section instead of creating a new
      remediation file.
    - Also update the original task state doc `docs/tasks/open/<issue-number>-*.md` with:
      - current review status
      - remediation file path
      - open remediation items summary

## Constraints

- **Non-Executory**: Do not run `npm test`, `npm run lint`, or `npm run type-check`.
- **Constructive & Specific**: Provide actionable feedback with specific line references where
  possible.
- **Project Alignment**: Alignment with `AGENTS.md` is mandatory.

## Output Contract

Your response must include a structured summary. **Every listed finding must have a severity
(P1/P2/P3) and a verifiable location** (file path and line range or symbol name).

- **Major Findings**: High-impact bugs or performance issues. Use **P1** for blocking issues;
  provide specific file and line references (or function/symbol name).
- **Refactoring Proposals**: Recommendations for barrel patterns or structural changes. Tag with
  **P2** or **P3**.
- **Test Coverage Assessment**: Identification of gaps in test suites. Reference
  `docs/TESTING_MATRIX.md` when relevant.
- **API Integration Test Impact**: (When `api` changes exist) State whether integration tests were
  added/updated or should be. If missing, list the required scenarios (auth, validation, contract,
  error paths) with target route(s).
- **Seed Script Impact**: State whether the DB seed script needs updates for the change set. If so,
  list concrete improvements (determinism/idempotency/realism/speed/safety) and the file(s)
  involved.
- **Practical / Real-World Gaps**: Scenarios where the solution may fall short (variable amounts,
  import flows, multiple similar items, missing UI/prefill for "correct" value). State what is
  addressed vs partially addressed vs not addressed; link to remediation section or follow-up issue
  if created.
- **Token Efficiency Score**: Evaluation of how "AI-ready" the code is (and any P2/P3 suggestions).
- **Architecture & UX Audit**: Summary of alignment with project architecture and UX rules. For
  listing or tabbed pages, consider `docs/architecture/LISTING_PAGE_ARCHITECTURE.md` and tabbed
  section header policy. For changes that touch dates or exports in `apps/web`, state whether user
  timezone is used for "today" defaults and export filenames (see lightframe anti-patterns).
- **ADR Alignment**: Which ADRs (from `docs/decisions/index.md`) were checked; confirmation that the
  change aligns with accepted decisions, or note any contradiction/drift and recommended follow-up.
- **Migration Status**: Confirmation of whether a migration was needed and if it exists.
- **Artifacts Created**: Paths to the Remediation Task file(s), any new ADRs, and any new GH issues
  for practical gaps.
- **Mission-critical** (when applicable): If the change touched auth, payments, PII, or core data
  flows—or a mission-critical pass was requested—include a subsection summarizing Security,
  Resilience, Observability, Data consistency, Audit, and Failure modes (see section below).

## Remediation File Minimum Template

Every remediation round must include:

- `Context` (issue number + original task file path)
- `Findings to fix` (checklist in **P1 → P2 → P3** order; each item must be verifiable: include file
  path and, where possible, line range or symbol name so the executor can locate the change)
- `Execution constraints`:
  - no commit
  - no PR
  - stay on current branch
  - run scoped quick checks
  - update original task state doc
  - push issue state with `npm run issues:push -- <issue-number> --state open`
- (Optional) **Practical / real-world gaps**: Subsection listing scenarios (e.g. variable amounts,
  import data, multiple similar items) with current behavior, what’s missing, and recommended fix.
  If a follow-up GH issue was created, reference it here.

## Review quality checklist (before finalizing)

- [ ] Every review lens has an explicit conclusion (no lens skipped).
- [ ] Every finding has a severity (P1/P2/P3) and a verifiable location (file + line or symbol).
- [ ] Remediation items are in P1 → P2 → P3 order and are actionable (executor can find the spot).
- [ ] When multiple issues were in scope, each has its own remediation file/round and task state
      updated.
- [ ] Output includes all Output Contract sections (Major Findings, Refactoring, Test Coverage,
      Practical Gaps, Token Efficiency, Architecture & UX, ADR Alignment, Migration, Artifacts; plus
      Mission-critical subsection when those lenses were applied).

## Mission-critical / high-assurance lenses

**When to apply**: (a) The change touches **auth**, **payments**, **PII**, or **core data flows**
(e.g. linking expenses to recurring, bulk updates, migrations, sensitive APIs). (b) Or the user
explicitly asks for a mission-critical, high-assurance, or hardening review on any change.

When applied, use these lenses (state an explicit conclusion per lens) and include a
**Mission-critical** subsection in the output. Tag findings with severity (P1/P2/P3) and location
like other findings.

- **Security**: Authorization checks on every sensitive operation; input validation and
  sanitization; no secrets or PII in logs; injection-resistant queries and parameterized APIs.
- **Resilience**: Retries with backoff where appropriate; timeouts on external calls; graceful
  degradation or clear error UX when dependencies fail; idempotency for non-idempotent-looking
  operations where duplicate submission is possible.
- **Observability**: Structured logging with enough context to debug in prod; correlation IDs or
  request context where applicable; failure modes that are visible (metrics/alerts) rather than
  silent.
- **Data consistency**: Use of transactions for multi-step writes; rollback or compensating actions
  on partial failure; migration safety (backward compatibility, no destructive defaults).
- **Audit & compliance**: Audit trail or logging for sensitive actions (e.g. link expense to
  recurring, bulk updates) where required by policy or regulation.
- **Failure modes**: Explicit consideration of "what happens when DB is down, third-party is slow,
  or user double-submits?" and whether the current behavior is acceptable.

If these lenses were not applicable (change is purely UI/cosmetic or out of scope), omit the
Mission-critical subsection or state "N/A – no auth/payments/PII/core-data impact."

## AI Token Optimization Guideline

- **Minimize Noise**: Suggest removing comments that only restate the code.
- **Structure for Context**: Favor patterns that encapsulate logic, making it easier for an AI to
  load only what it needs.
- **Dead Code Removal**: Ruthlessly identify and suggest removal of unused variables, imports, or
  dead branches.
