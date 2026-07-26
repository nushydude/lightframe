# 52 - Visible Curation Persistence Recovery

## Priority and Type

- Priority: P1
- Type: reliability and user feedback
- Dependency: coordinate with task 37

## Goal

Tell users when favorites or ratings were not saved and provide a reliable retry path without
pretending the mutation succeeded.

## Current Evidence

- `loadCuration`, `toggleFavorite`, `setRating`, batch favorite/rating actions, and clear operations
  in `src/state/curationStore.ts` catch command failures and only call `console.error`.
- Mutation promises resolve after the catch, so callers cannot distinguish success from failure.
- The store updates local curation only after a successful write, but the UI gives no explanation
  when a click appears to do nothing.
- Task 37 owns native atomicity and blocking-I/O placement; this task owns the frontend failure
  contract.

## Required State and Behavior

1. Add explicit load and mutation status, a normalized user-readable error, and failed-operation
   metadata sufficient to retry the latest failed operation.
2. Make mutation actions return a success result or reject with a typed error; do not convert a
   failure into an indistinguishable successful promise.
3. Serialize retries with the existing mutation queue and guard status with a monotonically
   increasing revision so older completions cannot clear newer errors.
4. Show a persistent, accessible alert in the active viewer/contact-sheet surface with `Retry` and
   dismiss behavior. Dismissal hides the message but does not mark data as persisted.
5. Keep local state consistent with confirmed disk state. If optimistic updates are introduced,
   specify and test rollback before implementation.
6. Treat initial-load failure separately from mutation failure and keep the app usable.

## Acceptance Criteria

- Every curation write failure is observable by both the caller and the user.
- Retry replays the latest failed intent against current state and clears the alert only on success.
- One rejected write does not poison later queued writes.
- Rapid writes cannot display a false saved state.
- Favorite/rating/filter behavior is unchanged on successful writes.

## Required Tests and Validation

- Test single, batch, clear, and initial-load failures.
- Test failed write followed by later success, failed retry, successful retry, and out-of-order
  completion protection.
- Add component tests for alert semantics, retry, and dismissal.
- Run focused curation store and affected component tests.
- Run `pnpm run ci:frontend`.

## Non-Goals

- No new curation storage format.
- No general toast framework.

## Reviewer Checklist

- Confirm callers cannot misread failure as success.
- Confirm the displayed state never claims unconfirmed persistence.
- Confirm retry preserves queue ordering and current user intent.
