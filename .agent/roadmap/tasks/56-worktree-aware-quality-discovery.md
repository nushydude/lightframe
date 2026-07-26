# 56 - Worktree-Aware Frontend Quality Discovery

## Priority and Type

- Priority: P1
- Type: developer tooling correctness
- Dependency: related to task 39

## Goal

Ensure frontend quality commands inspect only the current checkout and never traverse sibling task
worktrees stored under `.worktrees/`.

## Current Evidence

- `eslint.config.js` ignores build/cache paths but not `.worktrees/**`; `pnpm run lint` starts from
  `eslint .`.
- `vite.config.ts` does not constrain Vitest discovery to the current checkout's source tree or
  exclude `.worktrees/**`.
- From a primary checkout containing task worktrees, the audit observed Vitest discover 245 files
  and 2,284 tests instead of the isolated 49 files and 458 tests. Failures came from stale sibling
  worktree copies.
- The same audit observed 81 ESLint errors attributable only to sibling worktrees.

## Required Configuration

1. Ignore `.worktrees/**` in ESLint using the repository-level ignore mechanism.
2. Give Vitest an explicit current-checkout include pattern for tests under `src/` and exclude
   `.worktrees/**` defensively.
3. Exclude `.worktrees/**` from Vite development file watching where the primary checkout can see
   it.
4. Check other recursive quality tools used by `ci:frontend`, including Prettier and Fallow, and add
   the narrow supported exclusion when they can traverse sibling worktrees.
5. Keep ordinary untracked source files in the current checkout visible to quality tools.

## Acceptance Criteria

- `lint`, `test:run`, `format:check`, and Fallow produce the same project-file set with zero, one, or
  multiple sibling worktrees present.
- A deliberately failing test or lint fixture inside `.worktrees/` is not discovered.
- The same fixture under the current checkout's `src/` is discovered.
- No broad ignore hides application code, scripts, configuration, or roadmap documents.

## Required Tests and Validation

- Add a small configuration regression script or test that creates temporary sentinel files and
  asserts inclusion/exclusion without depending on the developer's real worktrees.
- Run the regression from both a primary checkout and an isolated task worktree.
- Run `pnpm run ci:frontend`.

## Non-Goals

- No package-manager upgrade or install-layout change; those belong to task 39.
- No deletion or relocation of existing worktrees.

## Reviewer Checklist

- Confirm every recursive frontend gate is covered.
- Confirm excludes are rooted narrowly at `.worktrees/`.
- Confirm the regression test cannot modify or delete real task worktrees.
