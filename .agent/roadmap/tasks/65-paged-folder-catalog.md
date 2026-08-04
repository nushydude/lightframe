# 65 - Paged Folder Catalog and Incremental Hydration

## Priority and Type

- Priority: P2
- Type: large-folder scalability
- Dependencies: task 35 and task 51
- Expected branch: `codex/paged-folder-catalog`
- Required final gate: `pnpm run ci:local`

## Goal

Replace whole-folder Rust-to-WebView `Vec<ImageFile>` transfers with a paged catalog API and
incremental frontend hydration while preserving navigation, sorting, filters, slideshow, watcher
updates, projector synchronization, and current-image identity.

This task targets folders with hundreds of thousands of images. It must not add cross-folder library
management.

## Required Performance Model

Define and document:

- default page size.
- maximum page size.
- memory budget and eviction strategy.
- prefetch window around current and visible ranges.
- total count and revision semantics.
- how current image is resolved when its page is unloaded.
- how sort/filter changes invalidate pages.
- how watcher deltas update total/order/revisions.

Do not choose page size by intuition alone; use serialized record size and synthetic-folder
measurements.

## Backend API

Implement contracts equivalent to:

```text
open_catalog(session_id, sort, filter) -> CatalogDescriptor
read_catalog_page(catalog_id, revision, offset_or_cursor, limit) -> CatalogPage
locate_image(catalog_id, image_id) -> CatalogPosition
refresh_catalog(catalog_id) -> CatalogRevisionResult
close_catalog(catalog_id)
```

`CatalogDescriptor` includes:

- catalog ID.
- revision.
- total count.
- effective sort/filter.
- current/initial image position when known.

Pages include stable image IDs and minimal display metadata.

## Cursor vs Offset Decision

Choose cursor or offset deliberately:

- Offset is simpler but shifts after watcher changes.
- Cursor is more stable but requires deterministic sort keys and tie-breakers.

The task plan recommends stable cursors containing sort key plus canonical identity. If offset is
chosen, watcher/revision behavior must invalidate and re-anchor pages safely.

## Storage Decision

Keep the current per-folder index if it can provide efficient page reads after an incremental
format change. Use SQLite/WAL only if measurements show JSON shards require full-file parsing for
every page and cannot meet the target.

If SQLite is selected:

- keep it cache-only unless a separate migration is approved.
- define schema version and rebuild behavior.
- use prepared queries and deterministic indexes.
- do not migrate settings or curation into it in this task.
- recover from corruption by rebuilding the affected catalog.

## Frontend Catalog Store

Maintain:

- descriptor and revision.
- loaded pages keyed by cursor/range.
- image-ID-to-known-position index.
- pending page requests and cancellation.
- bounded LRU/eviction.
- current image and visible window pins that cannot be evicted.

Components must be able to render unloaded placeholders and request pages without treating missing
data as an empty folder.

## Required Behavioral Rules

- Opening shows cached/first page promptly while refresh continues.
- Navigation across a page boundary prefetches before selection reaches the edge.
- Home/End resolve first/last without loading every page.
- Grid virtualization requests only visible/overscan pages.
- Compare pins both images.
- Slideshow maintains deterministic order and can advance across unloaded pages.
- Curation filters use backend-aware counts/pages or a proven indexed strategy.
- Watcher additions/removals/renames increment revision and preserve current image by ID.
- A stale page response is discarded.
- Projector receives image identity, not full catalog state.

## Required Tests

### Rust

- Deterministic page boundaries for all sort fields/directions.
- Stable tie-breakers and cursor behavior.
- Invalid page size/cursor/revision rejection.
- 100k synthetic records read without serializing the entire catalog response.
- Corrupt cache rebuild behavior.
- Watcher delta revision and anchor behavior.

### Frontend

- Boundary navigation and prefetch.
- stale response rejection.
- LRU eviction with current/visible pinning.
- grid placeholder-to-image hydration.
- sort/filter invalidation.
- current image preservation after watcher delta.
- Home/End, compare, projector, and slideshow across unloaded pages.
- no full-array assumption remains in named consumers.

## Performance Evidence

Add a manual/ignored benchmark recording:

- cold scan and cached open for 10k, 100k, and 500k synthetic entries.
- first-page response size and latency.
- memory after navigating/scrolling through multiple windows.
- IPC bytes compared with the previous whole-folder response.

Normal CI asserts bounded page/result sizes and store entry counts, not wall-clock timing.

## Validation Commands

```powershell
pnpm run test:run
cargo test --manifest-path src-tauri/Cargo.toml folder_index
pnpm run ci:local
```

Run the ignored/manual catalog benchmark and attach results to the PR.

## Acceptance Criteria

- Opening/using a catalog does not require sending all image records to the WebView.
- Page size and in-memory page count are bounded.
- Navigation, grid, compare, slideshow, filters, watcher, and projector work across unloaded pages.
- Stale revisions cannot overwrite current state.
- Existing folder-index data is migrated or safely rebuilt.
- No cross-folder library scope is introduced.

## Reviewer Checklist

- Search for surviving assumptions that `images` contains the full folder.
- Verify sort keys are deterministic and cursor-safe.
- Inspect eviction pinning and stale request handling.
- Confirm no hidden full-catalog serialization occurs per page.
- Review watcher changes at page boundaries and current-image preservation.
