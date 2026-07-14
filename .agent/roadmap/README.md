# LightFrame Roadmap Implementation Plans

This folder converts the README roadmap into implementation-ready task plans for agent execution.
Each task is intentionally scoped as a single branch and pull request unless the orchestrator decides
to split it further because the code diff becomes too broad.

## Current Audit

The current feature, performance, bug, and UI/UX audit is
[`AUDIT-2026-07-14.md`](AUDIT-2026-07-14.md). It records the audited version and evidence, distinguishes
features that already exist from missing behavior, assigns priorities, and defines the recommended
execution order for active work.

Tasks 01-41 are the original roadmap and audit backlog; some have already been implemented even
though their task files remain as design history. Before starting any task, compare its “Current
Code Context” with `main` and the current audit. Do not reimplement behavior already present.

Tasks 42-49 were created by the July 2026 audit:

42. `tasks/42-folder-sort-correctness.md`
43. `tasks/43-folder-sort-controls-and-fields.md`
44. `tasks/44-slideshow-mode-discoverability.md`
45. `tasks/45-symmetric-first-last-navigation.md`
46. `tasks/46-contact-sheet-filename-search.md`
47. `tasks/47-keyboard-accessible-image-collections.md`
48. `tasks/48-settings-validation-and-save-recovery.md`
49. `tasks/49-slideshow-display-sleep-inhibition.md`

## Execution Order

Use this order unless the user explicitly reprioritizes work:

1. `tasks/01-smarter-image-preloading.md`
2. `tasks/02-shared-thumbnail-cache.md`
3. `tasks/03-disk-backed-thumbnails.md`
4. `tasks/04-non-blocking-image-operations.md`
5. `tasks/05-faster-startup.md`
6. `tasks/06-large-image-preview-path.md`
7. `tasks/07-folder-scan-optimization.md`
8. `tasks/08-honor-default-fit-mode.md`
9. `tasks/09-mouse-wheel-navigation.md`
10. `tasks/10-persistent-window-bounds.md`
11. `tasks/11-navigation-cache-tuning.md`
12. `tasks/12-command-palette.md`
13. `tasks/13-crop-mode.md`
14. `tasks/14-save-cropped-copy.md`
15. `tasks/15-overwrite-crop-support.md`
16. `tasks/16-lossless-jpeg-rotation.md`
17. `tasks/17-edit-history-per-image.md`
18. `tasks/18-favorites-and-ratings.md`
19. `tasks/19-compare-view.md`
20. `tasks/20-quick-copy-move-workflows.md`
21. `tasks/21-improved-format-fallbacks.md`
22. `tasks/22-refresh-current-folder.md`
23. `tasks/23-open-in-external-editor.md`
24. `tasks/24-performance-telemetry-overlay.md`
25. `tasks/25-binary-preview-thumbnail-pipeline.md`
26. `tasks/26-priority-cancellable-image-work-scheduler.md`
27. `tasks/27-byte-budgeted-memory-governor.md`
28. `tasks/28-persistent-folder-index.md`
29. `tasks/29-incremental-folder-watcher.md`
30. `tasks/30-large-image-tiled-renderer.md`
31. `tasks/31-windows-native-codec-path.md`
32. `tasks/32-format-specific-detail-paths.md`
33. `tasks/33-raw-photo-sidecars.md`
34. `tasks/34-hot-path-store-subscription-tuning.md`
35. `tasks/35-scalable-folder-catalog.md`
36. `tasks/36-slideshow-large-folder-reconciliation.md`
37. `tasks/37-scalable-curation-persistence.md`
38. `tasks/38-windows-ci-release-parity.md`
39. `tasks/39-toolchain-install-hygiene.md`
40. `tasks/40-tauri-capability-scope-hardening.md`
41. `tasks/41-edit-queue-immutable-state-updates.md`

For new work, use the priority order in `AUDIT-2026-07-14.md` instead of assuming numeric task order
means unimplemented work.

## Shared Ground Rules

- Do not edit `README.md` unless the task explicitly says to update roadmap status.
- Keep each task on its own branch named `codex/<task-slug>`.
- Prefer existing app patterns: React function components, Zustand stores, Tauri commands, Vitest for
  frontend tests, Rust unit tests in `src-tauri/src/commands.rs` or adjacent modules.
- Preserve existing user changes. Check `git status --short` before editing.
- Run the task-specific checks listed in the plan, plus the CI-equivalent checks before PR:
  `pnpm build`, `pnpm test -- --run`, `cargo fmt -- --check`, `cargo clippy -- -D warnings`,
  and `cargo test` from `src-tauri`.
- If a task requires new dependencies, justify them in the PR body and keep them narrow.

## Orchestration Setup

Use these files when handing the task to a GPT 5.4 orchestrator:

- `.agent/orchestration/gpt-5.4-orchestrator-instructions.md`
- `.agent/orchestration/state-machine.md`
- `.agent/orchestration/gpt-5.5-reviewer-instructions.md`
- `.agent/orchestration/codex-5.5-medium-implementer-instructions.md`
