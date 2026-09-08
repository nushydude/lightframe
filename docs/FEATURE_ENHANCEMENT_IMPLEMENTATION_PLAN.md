# LightFrame feature enhancement implementation plan

## Purpose and status

This is an implementation handoff for the eight enhancements proposed during the feature review.
It is a roadmap, not a claim that the features are implemented or approved for delivery. The user
requested this planning document only. Do not treat it as authorization to commit, push, open a PR,
merge, or implement every task in one change.

Source baseline: `02d19eeef17568c8c0b7caea6928c709ead34dc3`, app version `8.7.7`.
The assessment was based on source inspection, not an interactive usability or performance audit.
Revalidate the baseline before implementation; file names below are existing entry points unless
explicitly identified as proposed new files. Product decisions below are recommended defaults,
which become the task specification when the user selects that task.

Product goal: make folder-based photo review faster, resumable, forgiving, and portable while
preserving LightFrame's responsive viewer and avoiding a mandatory catalog or cloud account.

## Execution contract for the receiving agent

1. Read `AGENTS.md`, `.agent/ANTIGRAVITY.md`, the orchestration instructions/state machine/reviewer
   contract, and applicable `.agent/skills/` files. Current repository instructions take precedence
   over this document if workflows change.
2. Select one task below. Extract its scope, acceptance criteria, dependencies, and checks into a
   task specification. Do not combine tasks into one PR without an explicit request.
3. Inspect `git status --short`. This planning file may still be uncommitted. The task bootstrap
   refuses a dirty source checkout: preserve the document and all user changes, and report the
   blocker if the source is dirty. Do not stash, commit, reset, or delete it automatically.
4. From a clean source checkout, run the repository bootstrap with the selected specification:

   ```powershell
   node scripts/agent-task.mjs start --slug <task-slug> --title "<task title>" --spec-file <spec-path>
   ```

   Use the resulting worktree based on freshly fetched `origin/main`; verify its branch/base SHA.
   Follow the helper's documented CLI for subsequent transitions and record state in
   `.agent/runtime/`. Do not invent flags for transitions or review recording.

5. Delegate implementation and independent review as prescribed by the orchestration contract.
   The implementation agent must not approve, commit, push, or open its own PR.
6. Run task checks and required final gates before review and after code remediation. Require the
   exact independent `APPROVED` result. Pass exact remediation checklists back to implementation;
   stop after three unchanged review cycles as required by `AGENTS.md`.
7. Local implementation/review may proceed when requested. Commit, push, and PR creation require
   explicit delivery authorization. Verify authentication, permissions, protection, and actual
   checks on the recorded PR head SHA. Merge and cleanup require the repository's separate
   authorization/lifecycle conditions.

## Delivery sequence

| Order | Task / suggested slug        | Depends on                          | Relative effort | Milestone           |
| ----- | ---------------------------- | ----------------------------------- | --------------- | ------------------- |
| 1     | A: `review-decisions`        | None                                | Medium          | Review workflow     |
| 2     | B: `resume-review-session`   | A for review-filter restoration     | Small–medium    | Review workflow     |
| 3     | C: `curation-undo-redo`      | A                                   | Medium          | Review workflow     |
| 4     | D: `compare-original-detail` | None                                | Medium–large    | Detail inspection   |
| 5     | E: `portable-curation-xmp`   | A; C for history integration        | Medium–large    | Editor handoff      |
| 6     | F: `batch-export-presets`    | Existing queue; no dependency on E  | Medium–large    | Delivery workflow   |
| 7     | G: `combined-review-filters` | A; update B's session schema        | Medium          | Folder navigation   |
| 8     | H: `raw-jpeg-pairing`        | A, C, E, F, G integration contracts | Medium–large    | Mixed-format review |

Ship A–C as the first product milestone, but review and deliver each task independently. D can
be selected earlier if fine-detail comparison is the user's primary need. Effort indicates relative
complexity, not a schedule. If a task needs subdivision, agree on explicit subtask acceptance criteria
before coding; do not silently omit portions of it.

## Shared architecture and behavior constraints

- Preserve preview-first loading, bounded memory, virtualized grids, cancellation, and stale-result
  protection. Do not decode every original or load all EXIF synchronously to enable a new feature.
- Keep durable writes in the Rust persistence/command layer. Extend the existing curation journal
  and shard mechanism rather than adding a competing metadata store.
- Keep transient UI state in Zustand. Use canonical path identity helpers for persisted identity,
  but use session/image IDs and destination grants at IPC boundaries. Never persist/reuse an expired
  session ID or turn a restored filesystem path into authorization.
- Maintain window ownership checks; projector windows must not acquire new write authority.
- Add versioned, backward-compatible schemas with deterministic migration and malformed-input
  validation on both sides of IPC. Preserve existing settings and curation fields.
- Keep browser development mode synthetic and incapable of native operations. Update runtime
  interfaces, native/browser/test adapters, command registration, and contract tests together.
- Destructive actions must remain explicit. A reject decision never moves or deletes a file.
- Route commands through shared actions, so toolbar, grid, keyboard, and command palette agree.
  Respect editable controls, modal focus, key repeat, and existing shortcuts.
- New controls require visible focus, accessible names, keyboard operation, and non-color-only state.
  Validate light/dark themes, high DPI, and narrow windows.
- Update README feature/behavior descriptions only when a task is implemented. Do not rewrite
  unrelated documentation, `CONTRIBUTING.md`, dependencies, or release configuration.

## A. Explicit review decisions

### Current gap and outcome

`src/types/curation.ts` currently stores favorite, rating, and update time. The `unreviewed` branch
in `src/services/curationFilter.ts` means no favorite and zero stars. Consequently, a deliberately
rejected photo cannot be distinguished from a photo never reviewed.

Add a separate `reviewStatus` with `unreviewed | keep | reject`. Stars express quality; favorite
expresses a bookmark; neither should overwrite an explicit decision.

### Implementation

1. Extend frontend types, Rust serialized records, single/batch mutations, and IPC payloads. Use
   `review_status` in Rust serialization and the established mapping style at the frontend boundary.
2. Migrate a legacy record with a favorite or rating above zero to `keep`; other legacy/missing
   records become `unreviewed`. This preserves the prior unreviewed set, but documents that legacy
   keep is inferred. An explicit stored status always wins over inference. Migration must be
   idempotent and must not rewrite every shard on each startup.
3. For new mutations, keep the fields independent: rating/favorite changes leave status untouched.
   Provide distinct actions for resetting only the review decision and clearing all curation.
4. Add keep/reject/unreviewed controls to viewer/grid, bulk actions, filters, and command palette.
   Propose `P` for keep, `X` for reject, `U` for unreviewed only after checking current bindings.
   Explain the independent states in concise help text.
5. Add folder progress and filtered-result counts with clear labels. Count the active folder's
   images, not unrelated cached curation. Keep/reject both count as reviewed.
6. Add `autoAdvanceAfterReviewDecision`, off by default. Apply it to single-image decision commands
   in the viewer only, not bulk operations, undo, or repeated no-op decisions.
7. After successful persistence, advance once using the pre-mutation ordering and identity. If a
   filter removes the image, select the next surviving successor without a second advance. At the
   end, stop; if no result remains, show the filter empty state. A failed write must not advance.

### Affected areas

`src/types/curation.ts`, `src/state/curationStore.ts`, `src/state/viewerStore.ts`,
`src/services/curationFilter.ts`, `src/services/tauriCommands.ts`,
`src/services/commandRegistry.ts`, `src/services/keyboardShortcutDispatcher.ts`,
`src/components/CurationFilterMenu.tsx`, `src/components/ContactSheet.tsx`, viewer chrome,
`src/types/settings.ts`, `src/components/SettingsPanel.tsx`, `src-tauri/src/curation.rs`,
`src-tauri/src/commands/curation_commands.rs`, and settings persistence.

### Acceptance and checks

- Legacy favorite/rating values survive migration; explicit unreviewed plus a rating remains valid.
- Decisions survive restart and refresh, and single/batch commands behave consistently.
- Reject never invokes file removal. Failure/retry uses the existing persistence alert flow.
- Filter-removal, last-image, rapid-input, and failed-write cases never skip an extra image.
- Cover old/malformed records, journal replay, batch failure semantics, keyboard targeting, counts,
  and navigation behavior. Extend curation/viewer/settings tests and Windows persistence E2E.
- Gate: `pnpm run ci:local`.

## B. Resume a review session

### Outcome and defaults

Recent folders and persisted marked selections exist, but they do not restore the full review
context. Offer an explicit **Continue reviewing** action at home and from recent folders. Ordinary
file-association/CLI opens must always honor the requested target first. Do not auto-launch a
projector, slideshow, comparison, or unfinished edit while restoring a session.

### Implementation

1. Add a versioned, bounded per-folder session record: canonical folder path, current image path,
   filter, sort criterion/direction, viewer/grid mode, grid anchor image plus local offset, and
   update time. Limit history to 12 folders, matching current recent-folder capacity. Reuse marked
   selection persistence rather than copying it into a second record.
2. Persist a trailing debounced snapshot (approximately 500 ms) on meaningful navigation changes;
   flush on folder change when possible. Use the existing serialized settings write path or a
   dedicated backend record if necessary to avoid racing frequent settings updates. Shutdown
   flushing is best-effort, not the only persistence mechanism.
3. Reacquire a normal authorized folder session, await the relevant curation/filter state, then
   restore once. Cancel restoration when the user opens a different folder or navigates manually.
4. Restore grid position by image identity, not only a raw scroll pixel value. If the target image
   is absent/filtered out, use the first matching result; if none exists, show the empty state.
5. Handle missing/offline folders with a recoverable message and retain the saved session. Add a
   clear-history control that removes resume data without erasing ratings or favorites.

### Affected areas and acceptance

Use `src/hooks/useAppStartupLifecycle.ts`, `src/hooks/useImageNavigation.ts`,
`src/services/startup.ts`, `src/services/markedSelectionPersistence.ts`, settings types/store/native
commands, `EmptyState.tsx`, recent-folder UI, and `ContactSheet.tsx`. Consider a focused new
`src/services/reviewSessionPersistence.ts` rather than enlarging the startup hook.

- Restart/continue restores the image, filter, sort, mode, and grid anchor.
- A CLI image open wins over any saved state. Restoring never revives a persisted session grant.
- Removed images, renamed folders, malformed records, changed filters, and stale async completions
  do not crash or redirect a later user action.
- Debounced writes do not lose unrelated settings updates or force synchronous work on each keypress.
- Extend startup/settings/navigation tests and a native restart E2E scenario.
- Gate: `pnpm run ci:local`.

## C. Undo and redo curation

### Scope and implementation

Undo only favorite, rating, and review-status changes, including bulk changes. File transfers,
deletions, crop overwrites, and external edits are excluded from this first history implementation.

1. Introduce a shared curation transaction/history service (proposed
   `src/services/curationHistory.ts`). All mutation entry points must pass through it. Record only
   successfully persisted changes, with affected identities and before/after field values.
2. Treat one batch action as one history entry. Establish actual backend batch atomicity before
   coding history: if the backend can partially succeed, record only confirmed successes and report
   failures rather than pretending the batch was atomic.
3. Serialize mutations and history operations. Undo/redo use the same validated persistence layer;
   do not bypass failure reporting. Write a new update timestamp rather than restoring an old one.
4. Bound history to 100 transactions and a separate 10,000 changed-image snapshot budget; discard
   oldest whole transactions. If one action exceeds that budget, apply the action with a clear
   non-undoable notice. Clear history on folder change and app restart for the first version.
5. New mutations clear redo. No-op actions create no entry. Failed undo/redo leaves history at the
   same position and remains retryable. Detect stale current values rather than overwriting newer
   external/imported changes; invalidate affected history with an explanation.
6. Add `Ctrl+Z`, `Ctrl+Shift+Z`, and `Ctrl+Y` where unbound, with disabled/enabled menu states and
   descriptions such as “Undo rating of 12 images.” Undo does not auto-advance; it reconciles the
   visible list and retains the current image when still visible.

### Acceptance and checks

Use curation store/commands, keyboard dispatcher, command registry, toast/alert UI, and new focused
history tests. Test consecutive edits to one image, batch changes, no-ops, failed initial writes,
failed undo, redo invalidation, bounds, external changes, filter membership, and text-input focus.
Verify session transitions do not leave actionable stale history. Gate: `pnpm run ci:local` because
this is a high-risk persistence behavior even if most edits are frontend-only.

## D. Full-detail comparison

### Current gap

`src/components/CompareView.tsx` loads previews with `PREVIEW_MAX_DIMENSION = 2048`. It already
shares zoom and pan through viewer state. The task is to enable original-detail inspection and
optional independent transforms, not to add shared zoom a second time.

### Implementation

1. Extract/reuse suitable image-source and rendering behavior from `ImageCanvas.tsx`,
   `imagePreviewStrategy.ts`, `TiledImageRenderer.tsx`, and asset-cache services. Avoid copying the
   entire viewer into two independent implementations.
2. Retain preview-first display. Request original or viewport tiles only when supported and needed;
   unsupported paths remain explicitly labeled as preview detail. Never label a scaled preview as
   original 100% detail.
3. Give each pane image dimensions, viewport dimensions, focus, request generation, and transform
   state. Define 100% consistently with the main viewer's existing pixel convention and verify it
   under display scaling. Source dimensions must drive detail math.
4. Default to linked transforms. Link using normalized source focal positions and a documented zoom
   convention, not blindly equal pixel offsets across different image sizes. Clamp each pane to its
   own bounds. Add a linked/independent toggle; re-link using the focused pane as the reference.
5. Preserve candidate navigation and stable reference behavior. Cancel obsolete pane requests on
   image changes, view exit, and source refresh. Share a bounded cache/scheduler budget across panes.
6. Show pane detail/loading/error status and keyboard focus clearly; provide accessible focus
   switching and avoid changing which pane receives navigation through incidental mouse movement.

### Acceptance and checks

- A known high-resolution JPEG reveals actual source detail at 100%, rather than enlarged preview.
- Different dimensions/orientations, small images, and high DPI preserve the expected focal region.
- Unsupported RAW/HEIC configurations display honest capability status without unsafe fallback.
- Rapid candidate switching never publishes old tiles/previews into the new image.
- Test independent/link transitions, source mutation, memory eviction, cancellation, and exiting
  compare; extend compare, tiled-renderer, zoom, and cache tests.
- Benchmark representative large-image comparisons against baseline and capture peak memory plus
  preview/detail latency. Existing resource caps must remain enforced. Gate: `pnpm run ci:local`.

## E. Portable curation through XMP

### Scope and mapping

Add explicit import/export, not automatic two-way synchronization. The app already reads XMP
information, but that does not establish curation writeback or interoperability.

- Map 0–5 stars to standard `xmp:Rating`; preserve favorite and review status using a documented
  LightFrame namespace. Do not map favorite to an arbitrary color label.
- Import standard rating `-1` as reject when no explicit LightFrame status is present. Preserve
  existing local stars in that case. For standard ratings 0–5, update stars but preserve an existing
  explicit local review decision; absent local/custom status may use A's legacy inference rule.
- Export reject in the LightFrame field while retaining standard stars. Clearly state that another
  application may not display the custom decision/favorite fields. Do not claim universal round-trip
  interoperability for those fields.
- First support XMP sidecars for proprietary RAW extensions where sidecar workflows are expected.
  Exclude DNG and embedded-metadata writeback to JPEG/TIFF from this task. Show unsupported formats
  explicitly; do not create misleading sidecars for them.

### Implementation

1. Inspect `src-tauri/src/image_metadata.rs`, `curation.rs`, `commands/curation_commands.rs`,
   `commands/mod.rs`, and `authority.rs`. Create a focused XMP curation module with bounded XML
   parsing and namespace-aware updates; reject malformed/oversized input without changing it.
2. Resolve case variants of existing sidecars according to existing path policy. If multiple
   plausible sidecars exist, report ambiguity. Never silently choose or overwrite the wrong one.
3. Show a dry-run list of changed fields and conflicts. Default to keeping local curation on import
   conflicts and skipping conflicting existing sidecar values on export until explicitly selected.
4. Preserve unrelated XML metadata semantically, including editor settings and unknown namespaces.
   Use atomic publication with destination authority and file revision checks. Handle concurrent
   editor changes, read-only files, symlinks/junctions, and destination replacement safely.
5. Import through C's transaction path so confirmed imported changes can be undone locally. Local
   undo must not imply that an exported sidecar has also been rolled back.
6. Provide per-file success/skip/failure summaries. No image pixel data or proprietary RAW contents
   should change. Do not generate recursive watcher/import loops.

### Acceptance and checks

Test real RAW-sidecar fixtures, missing/default fields, conflicting ratings, `-1`, custom-field
round-trip, unknown namespaces, malformed XML, size limits, sidecar ambiguity, concurrent changes,
failed publication, and authority denial. Prove unrelated metadata survives by parsing output.
Manually verify standard ratings with at least one available target editor; if unavailable, report
the interoperability check as unverified. Gate: `pnpm run ci:local`.

Primary reference: [Adobe XMP Basic namespace](https://developer.adobe.com/xmp/docs/xmp-namespaces/xmp/).
Recheck the standard and target application's current sidecar behavior during implementation.

## F. Batch export presets and accurate samples

### Outcome

Connect marked/filtered selections to the existing edit queue. Use named presets to produce a
reviewed deliverable with predictable names, sizes, encoding, and metadata policy.

### Implementation

1. Add versioned export presets to settings: name, supported format, longest-edge size, no-upscale
   default, codec quality where applicable, naming template, and metadata policy. Start with JPEG,
   PNG, and WebP after confirming encoder capabilities; retain existing source safety restrictions.
2. Use a small naming grammar such as `{name}`, `{index}`, and `{width}x{height}`. Validate Windows
   reserved names, separators, path traversal, case collisions, and maximum filename lengths.
3. Offer explicit scope: marked images, current filtered results, or current image. Freeze resolved
   source IDs and options at enqueue time so subsequent filter/preset edits do not alter jobs.
4. Select one destination folder, preview all output names, and default to skip existing files.
   Offer deterministic suffixing. Do not add overwrite in the first version. Revalidate collisions
   at publication time because the filesystem can change after preview.
5. Extend queue jobs and native export contracts together. Existing exact-file/consumable grants
   cannot simply be reused for a whole batch: introduce a bounded authorized batch plan or derive
   operation-specific grants on the backend. Retries must reacquire appropriate authority.
6. Keep bounded sequential/concurrent work consistent with resource policy. Report per-file results,
   retain retry, and distinguish pause from cancellation. Completed files remain completed if later
   jobs fail. Do not promise queue persistence across restart in this task.
7. Define metadata options precisely: preserve supported metadata, or strip descriptive/location
   metadata while retaining rendering-critical data such as the color profile. Normalize orientation
   after pixel transforms; avoid stale dimensions. Report unsupported preservation explicitly.
8. Replace the CSS approximation used by `QualityExportMenu.tsx` with a bounded sample produced by
   the actual resize/sharpen/encode pipeline. Debounce, cancel stale work, label sample resolution,
   and ensure preview settings match queued settings. This is not a full-resolution export on every
   slider movement.

### Affected areas and acceptance

Use `QualityExportMenu.tsx`, `EditQueuePanel.tsx`, `ContactSheet.tsx`, `editQueueStore.ts`, settings,
`tauriCommands.ts`, native export commands, `authority.rs`, and `image_resource_policy.rs`.

Test mixed supported/unsupported inputs, aspect ratio, no-upscale, alpha-to-JPEG background policy
(explicit white default), naming collisions, destination races, source changes, cancellation/retry,
metadata stripping, orientation/profile preservation, invalid grants, and stale samples. Verify
output dimensions, decoded pixels with suitable tolerances, and actual metadata rather than merely
checking that files exist. Gate: `pnpm run ci:local`.

## G. Combined filters and named views

### Current gap and implementation

`contactSheetSearch.ts` currently matches filename substrings. `CurationFilter` and saved presets
use a fixed enum. Add a versioned filter object while keeping those simple filters as shortcuts.

1. Support conjunctions of filename substring, minimum/maximum stars, review-state set, favorite,
   format set, width/height ranges, and capture-date range. Use explicit UI controls; no query
   language, nesting, regex, or arbitrary predicates in the first version.
2. Persist named views with stable IDs and migrate each legacy saved preset to its equivalent object.
   Update B's session restoration to accept the new schema and retain compatibility with old records.
3. Build one result pipeline shared by viewer, grid, slideshow, counts, and batch export. Apply
   filtering before established sorting; preserve image identity during reactive result changes.
4. Evaluate cheap filename/curation/format predicates first. Fetch dimensions/capture date only for
   remaining candidates through bounded background work and cache by source revision.
5. Unknown requested metadata must not be treated as a match or silently replaced by modified time.
   Show scanning progress; distinguish unreadable/absent metadata from metadata still loading. Use
   inclusive capture-date boundaries and a documented policy for EXIF timestamps without timezone.
6. Provide create/rename/delete/reset actions and an empty state that explains active filters.
   Avoid rescanning all metadata after every keystroke or rating change.

### Acceptance and checks

Use filter/search/sorting services, viewer store, curation menu, contact sheet, settings, metadata
cache and backend metadata commands. Test combinations, migrated presets, unknown metadata, date
boundaries, source invalidation, cancellation, session restoration, and identical result membership
across all consumers. Profile a generated 10,000-image catalog: filtering must preserve virtualization
and responsive input without eagerly decoding originals. Record timings instead of inventing a
performance claim. Gate: `pnpm run ci:local`.

## H. RAW+JPEG pairing

### Scope and defaults

Pairing is optional and off by default. Group one RAW plus one JPEG with the same stem in the same
folder, using canonical case rules. Do not infer pairs across directories or from timestamps alone.
Ambiguous groups remain separate with an explanation. Prefer JPEG for display, with a RAW toggle.

### Implementation

1. Add a derived logical review-item model above underlying file identities (proposed
   `src/services/imagePairing.ts`). Keep native session members and on-disk curation per file; do not
   replace the filesystem model or duplicate persistence in a group database.
2. Keep current navigation identity stable while toggling display variant. Show a pair badge and
   explicit variant name. Switching pairing off reveals the original individual files unchanged.
3. Default review/rating/favorite actions to the displayed file only; offer a visible “Apply curation
   to both” setting. Mixed existing states show mixed values rather than silently overwriting either.
   Applying to both produces one C history transaction with per-file results.
4. File copy/move/trash dialogs explicitly resolve displayed file versus both. Existing single-file
   destructive shortcuts must never silently expand to both. Sidecars may be included only through
   a clearly defined, authorized related-file policy; do not assume all same-stem files belong together.
5. F's export defaults to the displayed variant and explicitly supports choosing available variants;
   an unsupported RAW export is a skip/error, not an implicit JPEG substitution. E's XMP operations
   target the eligible RAW member and report the member they changed.
6. For G, an item matches when one member satisfies the entire conjunction; predicates cannot be
   satisfied by different members. If the displayed member does not match, show the matching variant.
   Counts distinguish logical items from physical files. Define and test sorting from the preferred
   available member so results are deterministic.
7. Reconcile watcher arrival/removal/rename and external editor updates by underlying identity.
   Pairing must not create duplicate selections, stale export jobs, or invalid resume targets.

### Acceptance and checks

Use image types/navigation/store, grid/thumbnail/caption surfaces, watcher reconciliation, curation,
transfer commands, compare selection, resume persistence, filters, and export planning.

Test mixed-case stems/extensions, two RAW candidates, multiple JPEG variants, missing member,
arrival during review, conflicting curation, bulk undo, hidden members, filter semantics, transfer
partial failures, and restart. Verify no destructive action affects an undisclosed member.
Gate: `pnpm run ci:local`.

## Cross-task validation and completion evidence

Run focused tests first, using actual discovered test paths. Existing commands include:

```powershell
pnpm exec vitest run src/state/curationStore.test.ts src/state/viewerStore.test.ts
pnpm exec vitest run src/components/CompareView.test.tsx
pnpm exec vitest run src/state/editQueueStore.test.ts
cargo test --manifest-path src-tauri/Cargo.toml
pnpm run ci:local
```

Use `pnpm run ci:frontend` for genuinely frontend-only low-risk changes and `pnpm run ci:rust` for
Rust-only changes when allowed by the active repository instructions. Tasks marked broad/high-risk
above require `ci:local`. Package scripts are the source of truth for exact gate contents.

For native behavior and restart/authority changes, also build and run applicable Windows checks:

```powershell
pnpm tauri build --no-bundle --ci
pnpm run smoke:windows
pnpm run e2e:windows
```

Extend the E2E harness where necessary: existing passing scenarios alone do not verify new features.
Use disposable fixture folders and an isolated app profile; never test destructive behavior against
the user's photo collection. Include JPEG, oriented JPEG, PNG alpha, large JPEG, unsupported or
codec-dependent RAW/HEIC, read-only files, and missing/offline folder scenarios where applicable.

For each task, the handoff to review must include:

- Selected task/spec path, base SHA, branch/worktree, and scoped changed files.
- Acceptance criteria mapped to actual tests or manual evidence.
- Exact check commands/results and any unverified platform/codec/editor behavior.
- Migration behavior and failure/retry evidence, including partial-success contracts.
- UI screenshots for changed controls at normal/high DPI and light/dark themes.
- Performance measurements for tasks D and G, plus any new background processing introduced elsewhere.
- Independent reviewer status and resolved remediation checklist.
- Remaining limitations and explicit delivery authorization status.

## Deferred work

Burst/duplicate grouping, histogram and clipping indicators, projector freeze/blank controls,
file-operation undo, automatic XMP synchronization, embedded metadata writeback, and durable queue
restart are separate future tasks. Do not add them opportunistically to this roadmap's implementation.
