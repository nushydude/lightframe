---
name: lightframe-test-matrix-runner
description: Select the smallest responsible validation commands based on changed scope.
---

# lightframe Test Matrix Runner

Use this workflow to run efficient and compliant verification.

## Selection Rules

1. Identify changed areas:
   - `apps/web` -> frontend behavior checks
   - `apps/api` -> API/backend checks
   - `packages/shared` -> shared build and downstream checks
   - broad/high-risk -> cross-cutting checks
2. Choose minimum required commands from `docs/TESTING_MATRIX.md`.
3. Prefer fast commands first for iteration:
   - `npm run lint:changed`
   - `npm run type-check:fast:web`
   - `npm run type-check:fast:api`
   - `npm run test:changed:web`
   - `npm run test:changed:api`
4. Before push readiness, run `npm run ci:local:silent` (or `npm run ci:local` when detail is
   needed).

## Execution Rules

- Trust exit code 0 for successful runs.
- Expand to broader test scope when changes are cross-cutting.
- For barrel/re-export refactors in high-stakes modules, require barrel smoke tests.

## Output Contract

Report commands and outcomes in this format:

- `<command>`: passed/failed
- `skips`: explicit reason
- `next required check`: command
