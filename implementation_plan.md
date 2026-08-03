# Implementation Plan — Remediate Audit Review Findings (CHANGES_REQUESTED)

Remediate all 8 findings from the independent review round.

## Remediation Strategy by Finding

1. **Frontend & Backend IPC Contracts (Finding 1)**
   - Add `get_thumbnail_by_id` command handler in Rust backend (`commands/mod.rs` & `lib.rs`).
   - Migrate `tauriCommands.ts`, `imageAssetCache.ts`, `useCuration.ts`, `useImageEditor.ts`, `useProjectorSyncLifecycle.ts`, and all UI components to pass session/image/grant IDs to IPC handlers (`get_image_metadata_by_id`, `get_thumbnail_by_id`, `get_image_tile_by_id`, `read_curation_metadata_by_id`, `read_curation_metadata_for_ids`, `write_image_curation_by_id`, `write_image_curation_batch_by_id`, `clear_image_curation_by_id`, `trash_image_by_id`, `copy_image_by_id`, `move_image_by_id`, `transfer_images_by_id`, `copy_image_by_id_to_clipboard`, `launch_external_editor_by_id`, `get_exif_metadata_by_id`, `rotate_image_by_id`, `save_cropped_copy_by_id`, `save_scaled_copy_by_id`, `overwrite_with_crop_by_id`).
   - Add a comprehensive packaged IPC contract test in frontend Vitest test suite exercising every registered production command.

2. **Raw-Path & Projector Authority Boundaries (Finding 2)**
   - Migrate remaining command families (`scan_folder`, `watch_folder`, `read_folder_index`, `get_image_caption`, `save_diagnostics_snapshot`, etc.) to use session/image IDs or grant IDs.
   - Refactor `useProjectorSyncLifecycle.ts` and backend projector event handlers to use `{ sessionId, imageId }` messages, authenticate sending window, and enforce window ownership (`window_label`) on session/grant creation, resolution, and closure.
   - Add unit tests for secondary-window denial, cross-window ID reuse, spoofed events, prefix-collision paths, and raw-path invocation.

3. **Strict Containment for Write Targets (Finding 3)**
   - Refactor `write_image_curation_batch_by_id` to resolve image IDs in batch curation instead of raw paths.
   - Refactor crop and scale copy handlers (`save_cropped_copy_by_id`, `save_scaled_copy_by_id`) to accept destination grant ID + relative file name output target instead of raw `output_path`.
   - Contain every path server-side and test rejection of raw-path injection, `..`, symlink/junction escapes, and outputs outside granted directories.

4. **Session-Aware Original Asset Protocol Streaming (Finding 4)**
   - Stream authorized original images through a session-aware custom asset protocol scheme (`lightframe-asset://session-id/image-id`) or generate authorized cache assets.
   - Verify full-resolution rendering, zoom, slideshow, tiles, and cache restart behavior.

5. **Frontend Cancellation & Stale Result Prevention (Finding 5)**
   - Pass caller-generated `requestId` from frontend callers down to `MediaExecutor`.
   - Connect frontend `AbortSignal` in `tauriCommands.ts` / `imageAssetCache.ts` to `cancel_media_request`.
   - Add cooperative `CancellationToken` checkpoints in decode/scaling loops and reject stale generations before cache publication.
   - Test cancellation of queued, running, and coalesced requests without stale results.

6. **Fail-Closed Pre-Decode Validation (Finding 6)**
   - Fail closed when dimensions cannot be established.
   - Validate encoded file size, dimensions, pixels, output limits, and working memory BEFORE every decoder or whole-file read in `thumbnails.rs`, `native_codecs.rs`, etc.
   - Add tests for malformed headers, oversized files, native fallbacks, excessive dimensions, and large tile sources.

7. **Executor Architecture, Metrics & Lifecycle (Finding 7)**
   - Replace unbounded Vec for execution durations with a ring buffer / bounded metric buffer.
   - Expose queue-wait and per-class telemetry metrics.
   - Wire deterministic `shutdown()` to app lifecycle cleanup (`RunEvent::Exit`).
   - Add barrier-based fairness, capacity, FIFO, and shutdown tests.

8. **XMP Attribute Error Propagation & Real Fixtures (Finding 8)**
   - Propagate attribute errors in `vendor/little_exif/src/xmp.rs` instead of `filter_map(Result::ok)`.
   - Update application-level fixture test in `commands/mod.rs` to use real base images proving the metadata parser/write path executed.
   - Test malformed attributes + successful valid-XMP rewrite + controlled malformed-XMP failure.

## Verification Plan

### Automated Tests

- Run `pnpm run ci:local` (includes frontend Vitest tests, Rust unit tests, cargo clippy, cargo fmt, ESLint, Prettier, Vite build, Fallow audit).
- Run `pnpm tauri build --no-bundle --ci`.
