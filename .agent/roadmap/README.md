# LightFrame October 2026 roadmap

The current program is [`AUDIT-2026-10-12-ARTCRAFT.md`](AUDIT-2026-10-12-ARTCRAFT.md). It preserves the October 12 GPT 6 Astra/high research record and adds a 2026-10-22 reconciliation against `cb06f9c` (8.7.20). Current code/merge evidence governs implementation status; the historical research does not establish completion. It supersedes the July audit’s blanket execution order for October work. [`AUDIT-2026-07-26.md`](AUDIT-2026-07-26.md) and [`AUDIT-2026-07-14.md`](AUDIT-2026-07-14.md) remain historical records.

The October program indexes 27 canonical plans, IDs 67–93, (24 recovered here; existing 67, 68, and 84 are preserved), plus revised ownership/status for selected existing owners 50–66. Each plan is one delivery responsibility with a direct dependency line, acceptance criteria, focused checks, and the required final gate. These are local canonical task files, not GitHub issues or sidebar chats. Selecting a plan later creates one fresh worktree/branch/PR through `agent-task start`; this documentation change creates no feature worktrees.

## October canonical plans

| ID  | Plan                                                                                               | Status / role                                          |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 67  | [Reduced-resolution JPEG decode](tasks/67-reduced-resolution-jpeg-decode.md)                       | Implemented — PR #223; reduced JPEG path               |
| 68  | [Bounded RAF embedded previews](tasks/68-bounded-raf-embedded-previews.md)                         | Implemented — PR #228; RAF preview only                |
| 69  | [TIFF/RAW embedded previews](tasks/69-tiff-raw-embedded-previews.md)                               | Planned — TIFF-family containers                       |
| 70  | [CR3 embedded previews](tasks/70-cr3-embedded-previews.md)                                         | Planned — bounded CR3 scan                             |
| 71  | [Generated-media colour consistency](tasks/71-generated-media-colour-consistency.md)               | Planned — generated thumbnails/previews/tiles          |
| 72  | [Export colour and metadata contract](tasks/72-export-colour-and-metadata-contract.md)             | Planned — export policy                                |
| 73  | [Namespace-aware XMP import](tasks/73-namespace-aware-xmp-import.md)                               | Planned — owned fields/provenance                      |
| 74  | [Safe XMP sidecar export](tasks/74-safe-xmp-sidecar-export.md)                                     | Planned — explicit sidecar write                       |
| 75  | [Unified background activity](tasks/75-unified-background-activity.md)                             | Planned — activity/progress/cancel semantics           |
| 76  | [Transactional curation undo/redo](tasks/76-transactional-curation-undo-redo.md)                   | Planned — history extension to 62                      |
| 77  | [Preview histogram and clipping](tasks/77-preview-histogram-and-clipping.md)                       | Planned — bounded display statistics                   |
| 78  | [Similarity and burst grouping](tasks/78-similarity-and-burst-grouping.md)                         | Optional planned — advisory grouping                   |
| 79  | [Advisory sharpness and clipping scores](tasks/79-advisory-sharpness-and-clipping-scores.md)       | Optional planned — no cull mutation                    |
| 80  | [Export sizing and quality presets](tasks/80-export-sizing-and-quality-presets.md)                 | Planned — preset UI/validation                         |
| 81  | [Paginated contact-sheet export](tasks/81-paginated-contact-sheet-export.md)                       | Planned — bounded PDF export                           |
| 82  | [Pending editor draft recovery](tasks/82-pending-editor-draft-recovery.md)                         | Planned — unqueued crop/rotation drafts                |
| 83  | [Curation transfer continuity](tasks/83-curation-transfer-continuity.md)                           | Planned — successful path remapping                    |
| 84  | [Licensed pinned media corpus](tasks/84-licensed-pinned-media-corpus.md)                           | Implemented infrastructure — PR #226; corpus validator |
| 85  | [Pixel golden and property harness](tasks/85-pixel-golden-and-property-test-harness.md)            | Planned infrastructure — required evidence             |
| 86  | [Windows media benchmark harness](tasks/86-windows-media-benchmark-harness.md)                     | Planned infrastructure — reproducible measurements     |
| 87  | [JPEG XL viewing](tasks/87-jpeg-xl-viewing.md)                                                     | Optional planned — viewing only                        |
| 88  | [PSD/PSB composite viewing](tasks/88-psd-psb-composite-viewing.md)                                 | Optional planned — composite only                      |
| 89  | [Non-WIC HEIF fallback](tasks/89-non-wic-heif-fallback.md)                                         | Optional planned — dependency/licence review           |
| 90  | [Compare targeting and candidate promotion](tasks/90-compare-targeting-and-candidate-promotion.md) | Optional planned — compare workflow                    |
| 91  | [Selected-photo survey](tasks/91-selected-photo-survey.md)                                         | Optional planned — survey selection                    |
| 92  | [Windows/WebView colour investigation](tasks/92-windows-webview-colour-investigation.md)           | Analysis — evidence may close with no native transform |
| 93  | [Authenticated local test/control](tasks/93-authenticated-local-test-control.md)                   | Optional planned — disabled-by-default harness         |

The unchanged 67/68/84 specifications retain their original planned wording and preimplementation context as design history. The statuses above and the audit's current evidence section govern completion; do not restart these deliveries from the historical text. Completed foundation status does not promise coverage for every future codec or metadata extension.

## Existing canonical owners and October treatment

| ID  | Plan                                                                                                  | October treatment                                                           |
| --- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 50  | [Remove vulnerable quick-xml](tasks/50-remove-vulnerable-quick-xml.md)                                | Implemented; reverify PR #212/current lock; retain historical specification |
| 51  | [Folder session path authority](tasks/51-folder-session-path-authority.md)                            | Planned prerequisite; preserves privileged path/session authority           |
| 52  | [Tauri capability and asset isolation](tasks/52-tauri-capability-and-asset-isolation.md)              | Planned prerequisite; preserves least privilege                             |
| 53  | [Native decode and edit guardrails](tasks/53-native-decode-and-edit-guardrails.md)                    | Implemented foundation — PR #218; revalidate new coverage                   |
| 54  | [Bounded native media executor](tasks/54-bounded-native-media-executor.md)                            | Implemented foundation — PR #221; pool and cache epochs                     |
| 55  | [Browser runtime and Tauri E2E](tasks/55-browser-compatible-runtime-boundary-and-e2e.md)              | Partially implemented; reverify and add real Windows shell coverage         |
| 56  | [Version/release gate correctness](tasks/56-version-lock-and-release-gate-correctness.md)             | Planned revalidation; 8.7.20 aligned; release gate remains                  |
| 57  | [Release supply chain and Windows trust](tasks/57-release-supply-chain-and-windows-trust.md)          | Planned after version facts                                                 |
| 58  | [Typed IPC and Rust domain modules](tasks/58-typed-ipc-and-rust-domain-modules.md)                    | Partially implemented; extend single-crate boundary checks                  |
| 59  | [Unified actions and viewer decomposition](tasks/59-unified-action-model-and-viewer-decomposition.md) | Partially implemented; preserve one action registry                         |
| 60  | [Viewer workspace IA](tasks/60-viewer-workspace-information-architecture.md)                          | Planned/partial; reuse viewer/grid/compare and pan/zoom                     |
| 61  | [Review-session curation model](tasks/61-review-session-curation-model.md)                            | Planned/partial; decisions/filters/progress owner                           |
| 62  | [Guided review session](tasks/62-guided-review-session-workflow.md)                                   | Planned/partial; owns Undo Last Decision                                    |
| 63  | [Settings IA/accessibility](tasks/63-settings-information-architecture-and-accessibility.md)          | Planned/partial; preserve existing settings recovery                        |
| 64  | [Contact-sheet density/bulk review](tasks/64-contact-sheet-density-and-bulk-review.md)                | Partially implemented; preserve density/search/bulk, finish tray/coherence  |
| 65  | [Paged folder catalog](tasks/65-paged-folder-catalog.md)                                              | Planned; page protocol owner                                                |
| 66  | [Support/privacy/updates/recovery](tasks/66-support-privacy-update-and-crash-recovery.md)             | Planned/partial; owns queued recovery and support trust                     |

## Historical numerical task list

The original numerical backlog remains design history. Its number does not imply that the behavior is absent or that it outranks the October program above; selected tasks must be revalidated against current code before implementation.

01–10: [01 smarter preloading](tasks/01-smarter-image-preloading.md), [02 shared thumbnail cache](tasks/02-shared-thumbnail-cache.md), [03 disk-backed thumbnails](tasks/03-disk-backed-thumbnails.md), [04 non-blocking image operations](tasks/04-non-blocking-image-operations.md), [05 faster startup](tasks/05-faster-startup.md), [06 large-image preview](tasks/06-large-image-preview-path.md), [07 folder scan](tasks/07-folder-scan-optimization.md), [08 default fit](tasks/08-honor-default-fit-mode.md), [09 wheel navigation](tasks/09-mouse-wheel-navigation.md), [10 window bounds](tasks/10-persistent-window-bounds.md).

11–20: [11 navigation cache](tasks/11-navigation-cache-tuning.md), [12 command palette](tasks/12-command-palette.md), [13 crop mode](tasks/13-crop-mode.md), [14 cropped copy](tasks/14-save-cropped-copy.md), [15 overwrite crop](tasks/15-overwrite-crop-support.md), [16 lossless rotation](tasks/16-lossless-jpeg-rotation.md), [17 edit history](tasks/17-edit-history-per-image.md), [18 favorites and ratings](tasks/18-favorites-and-ratings.md), [19 compare](tasks/19-compare-view.md), [20 copy/move workflows](tasks/20-quick-copy-move-workflows.md).

21–31: [21 format fallbacks](tasks/21-improved-format-fallbacks.md), [22 refresh folder](tasks/22-refresh-current-folder.md), [23 external editor](tasks/23-open-in-external-editor.md), [24 telemetry overlay](tasks/24-performance-telemetry-overlay.md), [25 binary preview pipeline](tasks/25-binary-preview-thumbnail-pipeline.md), [26 cancellable scheduler](tasks/26-priority-cancellable-image-work-scheduler.md), [27 memory governor](tasks/27-byte-budgeted-memory-governor.md), [28 persistent index](tasks/28-persistent-folder-index.md), [29 folder watcher](tasks/29-incremental-folder-watcher.md), [30 tiled renderer](tasks/30-large-image-tiled-renderer.md), [31 Windows codecs](tasks/31-windows-native-codec-path.md).

32–41: [32 format detail paths](tasks/32-format-specific-detail-paths.md), [33 RAW sidecars](tasks/33-raw-photo-sidecars.md), [34 store subscriptions](tasks/34-hot-path-store-subscription-tuning.md), [35 scalable catalog](tasks/35-scalable-folder-catalog.md), [36 slideshow reconciliation](tasks/36-slideshow-large-folder-reconciliation.md), [37 curation persistence](tasks/37-scalable-curation-persistence.md), [38 Windows CI parity](tasks/38-windows-ci-release-parity.md), [39 toolchain hygiene](tasks/39-toolchain-install-hygiene.md), [40 capability hardening](tasks/40-tauri-capability-scope-hardening.md), [41 immutable edit queue](tasks/41-edit-queue-immutable-state-updates.md).

42–49: [42 folder sort correctness](tasks/42-folder-sort-correctness.md), [43 sort controls](tasks/43-folder-sort-controls-and-fields.md), [44 slideshow discoverability](tasks/44-slideshow-mode-discoverability.md), [45 symmetric navigation](tasks/45-symmetric-first-last-navigation.md), [46 contact-sheet search](tasks/46-contact-sheet-filename-search.md), [47 keyboard image collections](tasks/47-keyboard-accessible-image-collections.md), [48 settings save recovery](tasks/48-settings-validation-and-save-recovery.md), [49 display sleep inhibition](tasks/49-slideshow-display-sleep-inhibition.md).

## Dependency phases

1. **Safety and evidence:** reverify 50/56; complete 51 and 52; revalidate implemented 53/84; start 85 and 86 without feature dependencies.
2. **Bounded platform:** revalidate implemented 54 (including cache epochs/root retirement); complete 55, 58 (typed IPC and deliberate layering violation), and 59.
3. **Media and identity:** reuse implemented 67/68; add 69/70 against current 53/54/84, and 71 after evidence foundation 85; then 61/62/64 and 73. Every decoder remains subject to 53 and 54.
4. **Review and continuity:** 75 first, then 76 and 83; 61/62/64 precede them. Compare/survey (90/91) follow stable actions, review workflow 62, and history 76 where redo is retained.
5. **Activity and output:** 74 after 75, then 72, 80, 81, 77, 78, 79, 82, and 66; keep queued recovery in 66 and unqueued drafts in 82.
6. **Optional and analysis:** 87, 88 after colour contract 71, 89, 92 after 55/84, and 93 after its direct prerequisites. 92 can close with evidence that existing WebView2 monitor correction is sufficient; it does not block 71.

The full ownership map, direct DAG, reuse/licence limits, deferred categories, lifecycle, and checks are in [`AUDIT-2026-10-12-ARTCRAFT.md`](AUDIT-2026-10-12-ARTCRAFT.md). The original numerical task list in the July index remains design history; the October program is authoritative for this migration.

## Shared execution contract

- Read `AGENTS.md`, `.agent/ANTIGRAVITY.md`, the task plan, applicable skills, and orchestration instructions before implementation.
- Verify current code against freshly fetched `origin/main`; preserve old acceptance guarantees and unrelated changes.
- Start the selected task with `node scripts/agent-task.mjs start --slug <slug> --title "<title>" --spec-file .agent/roadmap/tasks/<file>.md`.
- Run focused checks and the required final gate, then obtain an independent GPT 6 Astra/high reviewer `APPROVED`.
- Explicit delivery authorization is required before commit, push, or PR. The orchestrator records the PR head SHA and waits for checks for that SHA. Do not merge from these documents.
