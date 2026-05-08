# 18 - Favorites And Ratings

## Roadmap Item

Favorites and ratings: store lightweight sidecar metadata for quick curation without modifying
original files.

## Goal

Users should be able to mark images as favorite and assign simple ratings without changing the image
files. Metadata should live in a sidecar store.

## Current Code Context

- No metadata store exists.
- Settings are persisted through Rust JSON in app config dir.
- `ImageFile` represents scanned images.
- Chrome and contact sheet can show action state.

## Implementation Steps

1. Define metadata model:
   - path
   - favorite: boolean
   - rating: 0 to 5
   - updated_at
2. Use app config or app data directory for metadata:
   - `curation.json` for initial implementation.
   - Do not create sidecar files next to user images unless explicitly requested.
3. Add Rust commands:
   - `read_curation_metadata() -> HashMap<String, ImageCuration>`
   - `write_image_curation(file_path, favorite, rating)`
   - optionally `clear_image_curation(file_path)`.
4. Add frontend service wrappers in `tauriCommands.ts`.
5. Create `src/state/curationStore.ts`.
6. Load metadata once at app startup in `App.tsx`.
7. Add actions:
   - toggle favorite for current image
   - set rating 0-5 for current image
8. Add UI:
   - favorite toggle button in chrome.
   - rating control using keys 0-5 and optionally small buttons.
   - contact sheet thumbnail badges for favorite/rating.
9. Add keyboard shortcuts:
   - F or maybe `*` toggles favorite, but avoid conflict with fullscreen F11.
   - number keys 2-5 may conflict with zoom; use Alt+1..5 or command palette if task 12 exists.
10. Do not change sorting/filtering in this task unless minimal; add that as future work.

## Acceptance Criteria

- Favorite and rating persist across app restart.
- Original image files are never modified.
- Missing/deleted image paths in metadata do not break startup.
- Contact sheet and viewer show current curation state.
- Corrupt metadata file falls back gracefully with an error log.

## Tests

- Rust tests for metadata read/write and corrupt JSON behavior.
- Frontend store tests for toggle/set behavior.
- Run `cargo test`.
- Run `pnpm test -- --run`.
- Run `pnpm build`.

## Reviewer Focus

- Confirm metadata location is app-owned, not image-folder side effects.
- Confirm ratings are clamped to 0-5.
- Confirm corrupt metadata does not prevent image viewing.

