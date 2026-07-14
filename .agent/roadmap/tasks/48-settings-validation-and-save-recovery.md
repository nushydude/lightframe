# 48 - Settings Validation and Save Recovery

## Priority and Type

- Priority: P1
- Type: reliability and bug fix
- Dependencies: complete before task 43 changes the sort settings schema

## Problems

1. `settingsFromRust` accepts any non-empty string for some enum-like values by casting through
   `stringSetting`. Invalid persisted values can therefore enter `AppSettings` despite its TypeScript
   type.
2. `updateSettings` applies values optimistically and logs write failures, but the UI has no saving
   state, error message, or retry path. Users can believe a value is persisted when it is not.

## Goal

Validate every persisted setting at the application boundary and make settings-save state visible
and recoverable without losing the user's current in-memory choices.

## Validation Requirements

Add explicit parsers/type guards for every enum-like setting:

- theme: `system | dark | light`
- slideshowDirection: `forward | reverse`
- cropSaveMode: `copy | overwrite`
- mouseWheelBehavior: `zoom | navigate`
- defaultFitMode: `fit | fill | actual`
- sortOrder: current supported values; task 43 will extend them later
- performanceMode: existing guard
- updateChannel: `stable | preview`
- pinnable action ids: existing guard
- curation filter/preset values: existing guard

Also normalize numeric values loaded from disk:

- slideshow interval must be an integer in `[1, 60]`; otherwise use the default.
- window width/height must be finite positive numbers before being retained.
- recent-folder timestamps and persisted-marked-folder timestamps must be finite numbers.

An invalid field falls back independently. One invalid field must not discard other valid settings.

## Settings Store State

Extend `SettingsState` with:

```ts
saveStatus: 'idle' | 'saving' | 'error';
saveError: string | null;
loadError: string | null;
retrySaveSettings: () => Promise<boolean>;
updateSettings: (partial: Partial<AppSettings>) => Promise<boolean>;
```

Required semantics:

- `updateSettings` applies the partial value optimistically and queues a write of the full latest
  settings snapshot.
- `saveStatus` becomes `saving` while the newest queued snapshot is not resolved.
- Only the newest write revision may set `saveStatus` back to `idle`. Completion of an older queued
  write must not hide a newer pending write or error.
- On failure, retain current in-memory settings and return `false` for that update. If the failed
  revision is the newest queued revision, also set `saveStatus='error'` and store a user-readable
  message. If a newer revision is already queued, leave status as `saving`; that newer full snapshot
  is the recovery attempt and determines the final visible state.
- `retrySaveSettings` writes the latest current snapshot, not the snapshot that originally failed.
- A successful retry clears `saveError`, sets `idle`, and returns `true`.
- The queue must continue after a rejection; one failure must not poison later writes.
- Loading settings defaults after a read failure must set `loadError` visible in Settings. A
  successful later load clears it. Keep runtime defaults usable.

Use a monotonically increasing numeric write revision inside the store module. Do not compare object
identity or timestamps to decide which write is latest.

## UI Requirements

At the top of SettingsPanel, render:

- Saving: a small `Saving settings…` status with `role="status"`.
- Error: a persistent banner with `role="alert"`, text `Settings could not be saved.`, the normalized
  error detail, and a `Retry` button.
- Load error: a separate persistent banner with `role="alert"`, text
  `Saved settings could not be loaded. Defaults are in use.`, plus normalized error detail. Do not
  show a save Retry button for a read failure.
- Successful retry: remove the banner. Do not add a success toast for every normal settings write.

Closing and reopening Settings must not clear an unresolved save error.

## Files Expected to Change

- `src/types/settings.ts`
- `src/types/settings.test.ts`
- `src/state/settingsStore.ts`
- `src/state/settingsStore.test.ts`
- `src/components/SettingsPanel.tsx`
- `src/components/SettingsPanel.test.tsx`
- `src/index.css`

## Implementation Steps

1. Replace generic enum casts with explicit parsers.
2. Add numeric normalization helpers and table-driven conversion tests.
3. Add write revision, save state, and boolean results to settingsStore.
4. Keep the existing serialized write queue, but make success/error updates revision-aware.
5. Add retry of the latest snapshot.
6. Render saving/error UI and ensure it remains visible across panel reopen.
7. Update callers only where they rely on the old `Promise<void>` type. Callers that do not need a
   result may continue to use `void updateSettings(...)`.

## Required Tests

- Each valid enum value survives conversion.
- Each invalid/empty enum value falls back independently.
- Interval values below 1, above 60, fractional, NaN, and Infinity fall back.
- Invalid bounds/timestamps are dropped or defaulted without losing valid fields.
- Two rapid updates are written in order and the second snapshot contains both changes.
- An older successful write cannot set idle while a newer write is pending.
- A failed write sets error and returns false while retaining the in-memory value.
- The next update still writes after a prior rejection.
- Retry writes the latest snapshot and clears error only on success.
- SettingsPanel displays saving and error states and Retry calls the store action.

## Acceptance Criteria

- Unsupported persisted values never enter typed settings state.
- Users receive a visible, persistent warning when settings are not saved.
- Users can retry without re-entering preferences.
- Rapid changes cannot display a false saved/idle state.
- Existing settings files remain compatible.

## Validation Commands

```powershell
pnpm run test:run -- src/types/settings.test.ts src/state/settingsStore.test.ts src/components/SettingsPanel.test.tsx
pnpm run test:run
pnpm run build
```

## Non-Goals

- No settings-file format migration.
- No cloud sync.
- No per-setting undo.
- No replacement of the current JSON settings backend.
