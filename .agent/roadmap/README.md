# LightFrame Roadmap Implementation Plans

This folder converts the README roadmap into implementation-ready task plans for agent execution.
Each task is intentionally scoped as a single branch and pull request unless the orchestrator decides
to split it further because the code diff becomes too broad.

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
- `.agent/orchestration/codex-5.3-implementer-instructions.md`
